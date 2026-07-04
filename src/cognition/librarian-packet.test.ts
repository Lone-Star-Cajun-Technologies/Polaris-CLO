import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateLibrarianPacket } from "./librarian-packet.js";

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
});
