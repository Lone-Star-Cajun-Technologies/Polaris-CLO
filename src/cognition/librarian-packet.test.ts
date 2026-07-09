import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateLibrarianPacket } from "./librarian-packet.js";
import { validateCloseoutLibrarianResult } from "./closeout-librarian-types.js";

function initGitRepo(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  writeFileSync(join(root, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
}

describe("generateLibrarianPacket", () => {
  it("resolves the LoopState-shaped state.json even when a ClusterState-shaped cluster-state.json exists", () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-librarian-packet-test-"));
    try {
      initGitRepo(root);
      const clusterId = "POL-999";
      const clusterDir = join(root, ".polaris", "clusters", clusterId);
      mkdirSync(clusterDir, { recursive: true });
      mkdirSync(join(clusterDir, "results"), { recursive: true });

      // ClusterState schema (child_states, packet_pointers, ...) — no top-level `status`.
      writeFileSync(
        join(clusterDir, "cluster-state.json"),
        JSON.stringify({
          schema_version: "1.0",
          cluster_id: clusterId,
          state_generation: 1,
          child_states: [{ id: "POL-998", status: "done" }],
          claim_metadata: {},
          packet_pointers: {},
          result_pointers: {},
          validation_results: {},
          commits: {},
          tracker_mutations: {},
          blockers: [],
        }),
      );

      // LoopState schema (completed_children, run_id, ...) with a real cluster-complete status.
      writeFileSync(
        join(clusterDir, "state.json"),
        JSON.stringify({
          schema_version: "1.0",
          run_id: "polaris-run-test-2026-01-01-001",
          cluster_id: clusterId,
          active_child: "",
          completed_children: ["POL-998"],
          open_children: [],
          step_cursor: "checkpoint",
          context_budget: { children_completed: 1 },
          status: "cluster-complete",
          next_open_child: null,
          open_children_meta: { "POL-998": { title: "Test child" } },
        }),
      );

      const packetPath = generateLibrarianPacket({ repoRoot: root, clusterId });
      const packet = JSON.parse(readFileSync(packetPath, "utf-8"));

      expect(packet.cluster_id).toBe(clusterId);
      expect(packet.run_id).toBe("polaris-run-test-2026-01-01-001");
      expect(packet.completed_children).toEqual(["POL-998"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws a clear error when no completed children exist", () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-librarian-packet-test-"));
    try {
      initGitRepo(root);
      const clusterId = "POL-999";
      const clusterDir = join(root, ".polaris", "clusters", clusterId);
      mkdirSync(clusterDir, { recursive: true });

      writeFileSync(
        join(clusterDir, "state.json"),
        JSON.stringify({
          schema_version: "1.0",
          run_id: "polaris-run-test-2026-01-01-002",
          cluster_id: clusterId,
          active_child: "",
          completed_children: [],
          open_children: [],
          step_cursor: "checkpoint",
          context_budget: { children_completed: 0 },
          status: "cluster-complete",
          next_open_child: null,
        }),
      );

      expect(() => generateLibrarianPacket({ repoRoot: root, clusterId })).toThrow(
        /has no completed children/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("includes explicit artifact contracts for folders with and without SUMMARY.md", () => {
    const root = mkdtempSync(join(tmpdir(), "polaris-librarian-packet-test-"));
    try {
      initGitRepo(root);
      const clusterId = "POL-999";
      const clusterDir = join(root, ".polaris", "clusters", clusterId);
      const resultsDir = join(clusterDir, "results");
      mkdirSync(resultsDir, { recursive: true });

      mkdirSync(join(root, "src", "with-summary"), { recursive: true });
      mkdirSync(join(root, "src", "no-summary"), { recursive: true });
      writeFileSync(join(root, "src", "with-summary", "POLARIS.md"), "# with-summary\n");
      writeFileSync(join(root, "src", "with-summary", "SUMMARY.md"), "# summary\n");
      writeFileSync(join(root, "src", "with-summary", "feature.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "src", "no-summary", "POLARIS.md"), "# no-summary\n");
      writeFileSync(join(root, "src", "no-summary", "feature.ts"), "export const b = 1;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "route setup"], { cwd: root });
      writeFileSync(join(root, "src", "with-summary", "feature.ts"), "export const a = 2;\n");
      writeFileSync(join(root, "src", "no-summary", "feature.ts"), "export const b = 2;\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "worker change"], { cwd: root });
      const commitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf-8",
      }).trim();

      writeFileSync(
        join(resultsDir, "POL-100-result.json"),
        JSON.stringify({ child_id: "POL-100", commit: commitSha }),
      );
      writeFileSync(
        join(clusterDir, "state.json"),
        JSON.stringify({
          schema_version: "1.0",
          run_id: "polaris-run-test-2026-01-01-003",
          cluster_id: clusterId,
          active_child: "",
          completed_children: ["POL-100"],
          open_children: [],
          step_cursor: "checkpoint",
          context_budget: { children_completed: 1 },
          status: "cluster-complete",
          next_open_child: null,
          open_children_meta: { "POL-100": { title: "Contract child" } },
        }),
      );

      const packetPath = generateLibrarianPacket({ repoRoot: root, clusterId });
      const packet = JSON.parse(readFileSync(packetPath, "utf-8"));

      const byFolder = new Map(
        packet.polaris_md_paths.map((entry: Record<string, unknown>) => [
          entry["folder"],
          entry,
        ]),
      );

      const withSummary = byFolder.get("src/with-summary/") as Record<string, unknown>;
      const noSummary = byFolder.get("src/no-summary/") as Record<string, unknown>;
      expect(withSummary).toBeTruthy();
      expect(noSummary).toBeTruthy();
      expect(
        (withSummary["artifact_contract"] as Record<string, Record<string, unknown>>)["polaris_md"][
          "intent"
        ],
      ).toBe("must-reconcile");
      expect(
        (withSummary["artifact_contract"] as Record<string, Record<string, unknown>>)["summary_md"][
          "intent"
        ],
      ).toBe("reconcile-if-present");
      expect(
        (noSummary["artifact_contract"] as Record<string, Record<string, unknown>>)["summary_md"][
          "intent"
        ],
      ).toBe("not-present");
      expect(
        (noSummary["artifact_contract"] as Record<string, Record<string, unknown>>)["summary_md"][
          "path"
        ],
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("validateCloseoutLibrarianResult", () => {
  it("accepts explicit artifact reconciliation decisions, including one-file-only outcomes", () => {
    const errors = validateCloseoutLibrarianResult({
      schema_version: "1.0",
      role: "closeout-librarian",
      run_id: "run",
      dispatch_id: "dispatch",
      cluster_id: "POL-999",
      status: "success",
      commit_sha: "abc123",
      commit_message: "docs: reconcile route artifacts",
      files_committed: ["src/example/POLARIS.md"],
      polaris_md_updates: [],
      summary_md_updates: [],
      artifact_reconciliation: [
        {
          folder: "src/alpha/",
          decision: "polaris-only",
          polaris_md: "src/alpha/POLARIS.md",
          summary_md: "src/alpha/SUMMARY.md",
          reason: "Only operational doctrine changed.",
        },
        {
          folder: "src/beta/",
          decision: "summary-only",
          polaris_md: "src/beta/POLARIS.md",
          summary_md: "src/beta/SUMMARY.md",
          reason: "Only informational canon changed.",
        },
        {
          folder: "src/gamma/",
          decision: "both",
          polaris_md: "src/gamma/POLARIS.md",
          summary_md: "src/gamma/SUMMARY.md",
          reason: "Operational and informational canon both changed.",
        },
        {
          folder: "src/delta/",
          decision: "no-change",
          polaris_md: "src/delta/POLARIS.md",
          summary_md: null,
          reason: "No route cognition changes required.",
        },
      ],
      docs_ingested: [],
      docs_archived: [],
      yaml_updates: [],
      cognition_archived: [],
      link_validation: { total_checked: 0, valid: 0, broken: 0, repaired: 0, unrepairable: [] },
      blockers: [],
      reconciled_at: new Date().toISOString(),
      evidence_summary: "Reconciled route docs.",
    });

    expect(errors).toEqual([]);
  });
});
