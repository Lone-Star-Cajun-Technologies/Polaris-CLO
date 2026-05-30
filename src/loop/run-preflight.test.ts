import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { ensureClusterRunState } from "./run-preflight.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "polaris-run-preflight-"));
}

function writeClusterGraph(repoRoot: string, clusterId: string, children: string[]): void {
  const dir = join(repoRoot, ".polaris", "clusters", clusterId);
  mkdirSync(dir, { recursive: true });
  const nodes = Object.fromEntries(
    [clusterId, ...children].map((id) => [id, { id, title: `Title for ${id}`, status: "Todo" }]),
  );
  writeFileSync(
    join(dir, "clusters.json"),
    JSON.stringify({
      schemaVersion: "v2",
      source: { id: clusterId, type: "Linear", analysis: { id: "initial-sync", doc: "test" } },
      nodes,
      dependencies: {},
      clusters: {
        [clusterId]: {
          id: clusterId,
          title: `Cluster ${clusterId}`,
          children,
        },
      },
      activeCluster: clusterId,
    }),
    "utf-8",
  );
}

function writeClusterState(
  repoRoot: string,
  clusterId: string,
  children: Array<{ id: string; status: string }>,
): void {
  const dir = join(repoRoot, ".polaris", "clusters", clusterId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "cluster-state.json"),
    JSON.stringify(
      {
        schema_version: "1.0",
        cluster_id: clusterId,
        state_generation: 1,
        child_states: children,
        claim_metadata: {},
        packet_pointers: {},
        result_pointers: {},
        validation_results: {},
        commits: {},
        tracker_mutations: {},
        blockers: [],
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("ensureClusterRunState", () => {
  it("bootstraps a standalone cluster from the requested graph", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterGraph(repoRoot, "POL-232", ["POL-232"]);
      const stateFile = join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).toHaveBeenCalledWith({
        clusterId: "POL-232",
        openChildren: ["POL-232"],
        openChildrenMeta: {
          "POL-232": { title: "Title for POL-232" },
        },
        stateFile,
        repoRoot,
        artifactDir: join(repoRoot, ".taskchain_artifacts", "polaris-run"),
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("preserves mismatched current state before bootstrapping the requested cluster", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterGraph(repoRoot, "POL-232", ["POL-232"]);
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "old-run-001",
          cluster_id: "POL-201",
          active_child: "POL-203",
          completed_children: [],
          open_children: ["POL-203"],
          step_cursor: null,
          context_budget: { children_completed: 0 },
          status: "blocked",
          next_open_child: "POL-203",
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).toHaveBeenCalledOnce();
      expect(existsSync(stateFile)).toBe(false);
      const files = readdirSync(stateDir);
      expect(files.some((file) => file.startsWith("current-state.json.old-run-001-") && file.endsWith(".bak"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("reuses existing state when it already matches the requested cluster", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterState(repoRoot, "POL-232", [{ id: "POL-232", status: "ready" }]);
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "run-232",
          cluster_id: "POL-232",
          active_child: "",
          completed_children: [],
          open_children: ["POL-232"],
          step_cursor: null,
          context_budget: { children_completed: 0 },
          status: "running",
          next_open_child: "POL-232",
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when canonical cluster-state is missing for a reusable run", async () => {
    const repoRoot = makeRepo();
    try {
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "run-232",
          cluster_id: "POL-232",
          active_child: "",
          completed_children: [],
          open_children: ["POL-232"],
          step_cursor: null,
          context_budget: { children_completed: 0 },
          status: "running",
          next_open_child: "POL-232",
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await expect(
        ensureClusterRunState({
          clusterId: "POL-232",
          stateFile,
          repoRoot,
          bootstrapHandler,
        }),
      ).rejects.toThrow("missing canonical cluster-state");
      expect(bootstrapHandler).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("fails fast when canonical cluster-state drifts from current-state child references", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterState(repoRoot, "POL-232", [{ id: "POL-999", status: "ready" }]);
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "run-232",
          cluster_id: "POL-232",
          active_child: "",
          completed_children: [],
          open_children: ["POL-232"],
          step_cursor: null,
          context_budget: { children_completed: 0 },
          status: "running",
          next_open_child: "POL-232",
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await expect(
        ensureClusterRunState({
          clusterId: "POL-232",
          stateFile,
          repoRoot,
          bootstrapHandler,
        }),
      ).rejects.toThrow("missing children referenced by current-state.json: POL-232");
      expect(bootstrapHandler).not.toHaveBeenCalled();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("leaves an invalid matching state in place for downstream validation", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterGraph(repoRoot, "POL-232", ["POL-232"]);
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "run-232",
          cluster_id: "POL-232",
          active_child: null,
          completed_children: [],
          open_children: ["POL-232"],
          step_cursor: "dispatch",
          context_budget: { children_completed: 0 },
          status: "running",
          next_open_child: "POL-232",
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(stateFile, "utf-8")).active_child).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("leaves an invalid state without cluster identity in place for downstream validation", async () => {
    const repoRoot = makeRepo();
    try {
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(stateFile, JSON.stringify({ not_valid: true }), "utf-8");
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(stateFile, "utf-8"))).toEqual({ not_valid: true });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rebootstraps ghost-complete state when cluster-state still shows unfinished children", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterGraph(repoRoot, "POL-232", ["POL-232"]);
      writeClusterState(repoRoot, "POL-232", [{ id: "POL-232", status: "ready" }]);
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "run-232",
          cluster_id: "POL-232",
          active_child: "",
          completed_children: ["POL-232"],
          open_children: [],
          step_cursor: "checkpoint",
          context_budget: { children_completed: 1 },
          status: "cluster-complete",
          next_open_child: null,
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).toHaveBeenCalledOnce();
      const files = readdirSync(stateDir);
      expect(files.some((file) => file.startsWith("current-state.json.run-232-") && file.endsWith(".bak"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rebootstraps parseable invalid ghost-complete state from a direct-provider worker", async () => {
    const repoRoot = makeRepo();
    try {
      writeClusterGraph(repoRoot, "POL-232", ["POL-232"]);
      writeClusterState(repoRoot, "POL-232", [{ id: "POL-232", status: "ready" }]);
      const stateDir = join(repoRoot, ".taskchain_artifacts", "polaris-run");
      mkdirSync(stateDir, { recursive: true });
      const stateFile = join(stateDir, "current-state.json");
      writeFileSync(
        stateFile,
        JSON.stringify({
          schema_version: "1.0",
          run_id: "run-232",
          cluster_id: "POL-232",
          active_child: null,
          completed_children: ["POL-232"],
          open_children: [],
          step_cursor: "complete",
          context_budget: { children_completed: 1 },
          status: "cluster-complete",
          next_open_child: null,
        }),
        "utf-8",
      );
      const bootstrapHandler = vi.fn();

      await ensureClusterRunState({
        clusterId: "POL-232",
        stateFile,
        repoRoot,
        bootstrapHandler,
      });

      expect(bootstrapHandler).toHaveBeenCalledOnce();
      const files = readdirSync(stateDir);
      expect(files.some((file) => file.startsWith("current-state.json.run-232-") && file.endsWith(".bak"))).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
