/**
 * Trackerless Bootstrap Integration Test
 *
 * Exercises the full trackerless execution path:
 *   Spec file → SpecAdapter.syncIn() → LocalGraph → runLoopBootstrapInit() → state file
 *
 * No tracker adapter is configured or called.
 * The cluster-state store is mocked to keep the test self-contained.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpecAdapter } from "../tracker/adapters/spec/index.js";
import { runLoopBootstrapInit } from "./run-bootstrap.js";

vi.mock("../cluster-state/store.js", () => ({
  readClusterState: vi.fn().mockResolvedValue(null),
  initializeClusterState: vi.fn().mockResolvedValue(undefined),
}));

describe("Trackerless bootstrap integration", () => {
  let tempDir: string;
  let specPath: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `polaris-trackerless-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    specPath = join(tempDir, "my-feature.md");
    writeFileSync(
      specPath,
      [
        "## Objective",
        "Build the trackerless feature end-to-end.",
        "",
        "## Scope",
        "- src/core/feature.ts",
        "- src/core/feature.test.ts",
        "",
        "## Validation",
        "- npm run build",
        "- npm test",
        "",
        "## Children",
        "- Implement core logic",
        "- Add unit tests",
        "- Wire CLI integration",
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("SpecAdapter.syncIn produces a LocalGraph with correct cluster_id and children", async () => {
    const graph = await new SpecAdapter().syncIn(specPath);

    expect(graph.fullGraph.source.type).toBe("spec");
    expect(graph.fullGraph.activeCluster).toBe("spec-my-feature");

    const cluster = graph.getActiveCluster();
    expect(cluster.children).toEqual([
      "spec-child-01",
      "spec-child-02",
      "spec-child-03",
    ]);
    expect(graph.getNode("spec-child-01")?.title).toBe("Implement core logic");
    expect(graph.getNode("spec-child-02")?.title).toBe("Add unit tests");
    expect(graph.getNode("spec-child-03")?.title).toBe("Wire CLI integration");
  });

  it("runLoopBootstrapInit writes state with cluster_id and open_children derived from spec", async () => {
    const graph = await new SpecAdapter().syncIn(specPath);
    const clusterId = graph.fullGraph.activeCluster;
    const openChildren = graph.getActiveCluster().children;

    const stateFile = join(tempDir, "current-state.json");

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runLoopBootstrapInit({
      clusterId,
      openChildren,
      stateFile,
      repoRoot: tempDir,
      runId: "test-run-trackerless-001",
    });

    const raw = readFileSync(stateFile, "utf-8");
    const state = JSON.parse(raw);

    expect(state.cluster_id).toBe("spec-my-feature");
    expect(state.open_children).toEqual([
      "spec-child-01",
      "spec-child-02",
      "spec-child-03",
    ]);
    expect(state.run_id).toBe("test-run-trackerless-001");
    expect(state.completed_children).toEqual([]);
    expect(state.status).toBe("running");
  });

  it("bootstrap seal is present and valid in the written state", async () => {
    const stateFile = join(tempDir, "current-state.json");
    const raw = readFileSync(stateFile, "utf-8");
    const state = JSON.parse(raw);

    expect(state.run_bootstrap_seal).toBeDefined();
    expect(state.run_bootstrap_seal.sealer).toBe("polaris-loop-bootstrap");
    expect(state.run_bootstrap_seal.run_id).toBe("test-run-trackerless-001");
    expect(state.run_bootstrap_seal.cluster_id).toBe("spec-my-feature");
    expect(typeof state.run_bootstrap_seal.open_children_sha).toBe("string");
    expect(state.run_bootstrap_seal.open_children_sha.length).toBeGreaterThan(0);
  });

  it("state next_open_child matches the first child from the spec", async () => {
    const stateFile = join(tempDir, "current-state.json");
    const raw = readFileSync(stateFile, "utf-8");
    const state = JSON.parse(raw);

    expect(state.next_open_child).toBe("spec-child-01");
  });
});
