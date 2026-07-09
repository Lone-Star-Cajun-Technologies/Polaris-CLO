import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeClusterState, pruneMissingQcRunPointers, readClusterState, recordQcRun } from "./store.js";
import type { QcResult } from "../qc/types.js";

const scratchRoots: string[] = [];

function makeRepoRoot(name: string): string {
  const repoRoot = path.join(
    process.cwd(),
    ".test-scratch",
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(repoRoot, { recursive: true });
  scratchRoots.push(repoRoot);
  return repoRoot;
}

function writeClustersFile(repoRoot: string, clusterId: string, payload: unknown): void {
  const clusterDir = path.join(repoRoot, ".polaris", "clusters", clusterId);
  mkdirSync(clusterDir, { recursive: true });
  writeFileSync(path.join(clusterDir, "clusters.json"), JSON.stringify(payload, null, 2), "utf-8");
}

afterEach(() => {
  for (const repoRoot of scratchRoots.splice(0)) {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

describe("initializeClusterState", () => {
  it("initializes ready child state from a v2 clusters.json graph without leaking tracker statuses", async () => {
    const clusterId = "POL-204-V2";
    const repoRoot = makeRepoRoot("cluster-state-v2");
    writeClustersFile(repoRoot, clusterId, {
      schemaVersion: "v2",
      source: {
        id: clusterId,
        type: "Linear",
        analysis: { id: "POL-199", doc: "smartdocs/docs/architecture/runtime-state-consolidation-spec.md" },
      },
      nodes: {
        [clusterId]: { id: clusterId, title: "Cluster", status: "Backlog" },
        "POL-301": { id: "POL-301", title: "First child", status: "In Progress", sessionType: "implement" },
        "POL-302": { id: "POL-302", title: "Second child", status: "Done", sessionType: "implement" },
      },
      dependencies: {
        "POL-302": ["POL-301"],
      },
      clusters: {
        [clusterId]: {
          id: clusterId,
          title: "Cluster",
          children: ["POL-301", "POL-302"],
        },
      },
      activeCluster: clusterId,
    });

    const state = await initializeClusterState(clusterId, repoRoot);

    expect(state.child_states).toEqual([
      { id: "POL-301", status: "ready" },
      { id: "POL-302", status: "ready" },
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(repoRoot, ".polaris", "clusters", clusterId, "clusters.json"), "utf-8"),
      ).nodes["POL-302"].status,
    ).toBe("Done");
    await expect(readClusterState(clusterId, repoRoot)).resolves.toEqual(state);
  });

  it("initializes ready child state from a legacy v1 clusters.json graph", async () => {
    const clusterId = "POL-204-V1";
    const repoRoot = makeRepoRoot("cluster-state-v1");
    writeClustersFile(repoRoot, clusterId, {
      source_id: clusterId,
      analyze_source_id: "POL-199",
      source_type: "linear",
      created_at: "2026-05-29T00:00:00.000Z",
      analysis_doc: "smartdocs/docs/doctrine/candidate/pol-199-runtime-state-consolidation-analysis.md",
      clusters: [
        {
          cluster_id: clusterId,
          description: "Legacy cluster",
          children: [
            {
              id: "POL-401",
              title: "Legacy first child",
              session_type: "implement",
              blockedBy: [],
            },
            {
              id: "POL-402",
              title: "Legacy second child",
              session_type: "implement",
              blockedBy: ["POL-401"],
            },
          ],
        },
      ],
    });

    const state = await initializeClusterState(clusterId, repoRoot);

    expect(state.child_states).toEqual([
      { id: "POL-401", status: "ready" },
      { id: "POL-402", status: "ready" },
    ]);
    await expect(readClusterState(clusterId, repoRoot)).resolves.toEqual(state);
  });
});

describe("recordQcRun", () => {
  function makeResult(qcRunId: string, overrides: Partial<QcResult> = {}): QcResult {
    const now = new Date().toISOString();
    return {
      schemaVersion: "1.0",
      qcRunId,
      runId: "run-1",
      clusterId: "POL-204-V2",
      trigger: "completed-cluster",
      provider: "coderabbit",
      providerMode: "local",
      startedAt: now,
      completedAt: now,
      status: "findings",
      findings: [],
      rawArtifactPaths: [],
      parserVersion: "coderabbit-1.0",
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: true,
        routedToRepair: false,
        summary: "2 findings",
      },
      ...overrides,
    };
  }

  it("persists a QC artifact and records a pointer in cluster state", async () => {
    const clusterId = "POL-204-QC";
    const repoRoot = makeRepoRoot("cluster-state-qc");
    writeClustersFile(repoRoot, clusterId, {
      schemaVersion: "v2",
      source: { id: clusterId, type: "Linear" },
      nodes: { [clusterId]: { id: clusterId, title: "Cluster", status: "Backlog" } },
      dependencies: {},
      clusters: { [clusterId]: { id: clusterId, title: "Cluster", children: [] } },
      activeCluster: clusterId,
    });

    await initializeClusterState(clusterId, repoRoot);
    const result = makeResult("qc-run-1");
    const { artifactPath, state } = await recordQcRun(clusterId, result, repoRoot);

    expect(artifactPath).toContain(path.join(".polaris", "clusters", clusterId, "qc", "qc-run-1.json"));
    const qcRuns = state.qc_runs ?? {};
    expect(qcRuns["qc-run-1"]).toEqual({
      artifact_path: artifactPath,
      status: "findings",
      provider: "coderabbit",
      started_at: result.startedAt,
      completed_at: result.completedAt,
      availability: "available",
    });

    const reloaded = await readClusterState(clusterId, repoRoot);
    expect((reloaded?.qc_runs ?? {})["qc-run-1"]).toEqual(qcRuns["qc-run-1"]);
    expect(JSON.parse(readFileSync(artifactPath, "utf-8"))).toEqual(result);
  });

  it("marks failed provider pointers unavailable when audit artifacts are missing", async () => {
    const clusterId = "POL-204-FAILED";
    const repoRoot = makeRepoRoot("cluster-state-failed-qc");
    writeClustersFile(repoRoot, clusterId, {
      schemaVersion: "v2",
      source: { id: clusterId, type: "Linear" },
      nodes: { [clusterId]: { id: clusterId, title: "Cluster", status: "Backlog" } },
      dependencies: {},
      clusters: { [clusterId]: { id: clusterId, title: "Cluster", children: [] } },
      activeCluster: clusterId,
    });

    await initializeClusterState(clusterId, repoRoot);
    const result = makeResult("qc-run-failed", {
      status: "failed",
      allProvidersFailed: true,
      rawArtifactPaths: [path.join(repoRoot, "missing-raw.log")],
      providerAttempt: {
        provider: "coderabbit",
        status: "failure",
        rawOutputAvailable: false,
        rawOutputRetained: false,
        stdoutLength: 0,
        stderrLength: 0,
      },
    });
    const { state } = await recordQcRun(clusterId, result, repoRoot);

    const pointer = (state.qc_runs ?? {})["qc-run-failed"];
    expect(pointer).toBeDefined();
    expect(pointer.availability).toBe("unavailable");
    expect(pointer.raw_artifact_paths).toContain(path.join(repoRoot, "missing-raw.log"));
  });
});

describe("pruneMissingQcRunPointers", () => {
  it("removes pointers to missing primary artifacts and warns", () => {
    const state = {
      schema_version: "1.0",
      cluster_id: "POL-PRUNE",
      state_generation: 3,
      child_states: [],
      claim_metadata: {},
      packet_pointers: {},
      result_pointers: {},
      validation_results: {},
      commits: {},
      tracker_mutations: {},
      blockers: [],
      qc_runs: {
        "existing-run": {
          artifact_path: path.join(process.cwd(), "package.json"),
          status: "passed" as const,
          provider: "coderabbit",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
        "missing-run": {
          artifact_path: path.join(process.cwd(), "missing-qc-artifact.json"),
          status: "passed" as const,
          provider: "coderabbit",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
      },
    };

    const { state: cleaned, pruned, warnings } = pruneMissingQcRunPointers(state);

    expect(pruned).toEqual(["missing-run"]);
    expect(warnings.length).toBeGreaterThan(0);
    expect(cleaned.qc_runs).toHaveProperty("existing-run");
    expect(cleaned.qc_runs).not.toHaveProperty("missing-run");
  });
});
