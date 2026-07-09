/**
 * Regression tests for the POL-516 run artifacts committed under
 * `.polaris/clusters/POL-516/**` and `.polaris/map/*.json`.
 *
 * These are data artifacts produced by a real Polaris run (cluster state,
 * execution graph, QC provider results, repair-packet manifests, worker and
 * librarian packets/results, and the file-routes/index map). They contain no
 * executable logic of their own, so these tests validate them against the
 * schemas/validators and invariant-computing helpers that the runtime uses to
 * read and trust these artifacts. This guards against the artifacts drifting
 * out of sync with the contracts the runtime depends on.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

import { validateQcResult, validateRepairPacketManifest } from "../../src/qc/schemas.js";
import type { QcResult, QcRepairPacketManifest } from "../../src/qc/types.js";
import { executionGraphV2Schema } from "../../src/tracker/schema.js";
import {
  validateCloseoutLibrarianPacket,
  validateCloseoutLibrarianResult,
  checkLibrarianResultGate,
} from "../../src/cognition/closeout-librarian-types.js";
import type {
  CloseoutLibrarianPacket,
  CloseoutLibrarianResult,
} from "../../src/cognition/closeout-librarian-types.js";
import { computeInstructionCoverage } from "../../src/map/atlas.js";
import type { FileRouteEntry, AtlasIndex } from "../../src/map/atlas.js";
import { roleContextForWorkerRole } from "../../src/loop/worker-packet.js";
import type { ClusterState } from "../../src/cluster-state/types.js";
import type { CurrentState } from "../../src/types/runtime-state.js";

const REPO_ROOT = process.cwd();
const CLUSTER_DIR = path.join(REPO_ROOT, ".polaris", "clusters", "POL-516");
const MAP_DIR = path.join(REPO_ROOT, ".polaris", "map");

function readJson<T = unknown>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(...segments), "utf-8")) as T;
}

describe("POL-516 cluster-state.json", () => {
  const state = readJson<ClusterState>(CLUSTER_DIR, "cluster-state.json");

  it("has the expected top-level identifiers", () => {
    expect(state.schema_version).toBe("1.0");
    expect(state.cluster_id).toBe("POL-516");
    expect(typeof state.state_generation).toBe("number");
    expect(state.state_generation).toBeGreaterThan(0);
  });

  it("records all six children as done with a commit for each", () => {
    const expectedChildren = ["POL-522", "POL-521", "POL-520", "POL-519", "POL-518", "POL-517"];
    expect(state.child_states.map((c) => c.id).sort()).toEqual([...expectedChildren].sort());
    for (const child of state.child_states) {
      expect(child.status).toBe("done");
      expect(state.commits[child.id]).toBeTruthy();
    }
  });

  it("has a validation_results entry marked passed for every completed child", () => {
    for (const child of state.child_states) {
      const validation = state.validation_results[child.id];
      expect(validation).toBeDefined();
      expect(validation.passed).toBe(true);
    }
  });

  it("has no unresolved blockers and an empty tracker_mutations map", () => {
    expect(state.blockers).toEqual([]);
    expect(state.tracker_mutations).toEqual({});
  });

  it("qc_runs pointers use a valid QcRunStatus for every recorded run", () => {
    const validStatuses = new Set(["passed", "findings", "blocked", "failed", "skipped"]);
    expect(state.qc_runs).toBeDefined();
    const qcRuns = state.qc_runs ?? {};
    expect(Object.keys(qcRuns).length).toBeGreaterThan(0);
    for (const pointer of Object.values(qcRuns)) {
      expect(validStatuses.has(pointer.status)).toBe(true);
      expect(pointer.provider).toBe("coderabbit");
      expect(pointer.artifact_path).toContain(pointer.provider);
    }
  });

  it("records the qc_repair_manifests pointer for the round referenced by qc_repair_outcome", () => {
    expect(state.qc_repair_outcome).toBe("no-repairable");
    expect(state.qc_repair_manifests).toBeDefined();
    expect(state.qc_repair_manifests?.[1]).toContain("repair-rounds/1/repair-packets.json");
  });
});

describe("POL-516 clusters.json (execution graph v2)", () => {
  const raw = readJson(CLUSTER_DIR, "clusters.json");

  it("validates against executionGraphV2Schema", () => {
    const result = executionGraphV2Schema.safeParse(raw);
    expect(result.success).toBe(true);
  });

  it("has an activeCluster that exists in the clusters map", () => {
    const graph = raw as { activeCluster: string; clusters: Record<string, unknown> };
    expect(graph.clusters[graph.activeCluster]).toBeDefined();
  });

  it("only references node ids that exist in the nodes map from dependencies and cluster children", () => {
    const graph = raw as {
      nodes: Record<string, unknown>;
      dependencies: Record<string, string[]>;
      clusters: Record<string, { children: string[]; cluster_root?: string }>;
    };
    const nodeIds = new Set(Object.keys(graph.nodes));

    for (const [childId, blockedBy] of Object.entries(graph.dependencies)) {
      expect(nodeIds.has(childId)).toBe(true);
      for (const dep of blockedBy) {
        expect(nodeIds.has(dep)).toBe(true);
      }
    }

    for (const cluster of Object.values(graph.clusters)) {
      for (const childId of cluster.children) {
        expect(nodeIds.has(childId)).toBe(true);
      }
      if (cluster.cluster_root) {
        expect(nodeIds.has(cluster.cluster_root)).toBe(true);
      }
    }
  });

  it("declares POL-522 depending on all four remaining implementation children", () => {
    const graph = raw as { dependencies: Record<string, string[]> };
    expect(graph.dependencies["POL-522"].sort()).toEqual(
      ["POL-518", "POL-519", "POL-520", "POL-521"].sort(),
    );
  });
});

describe("POL-516 QC run artifacts", () => {
  const qcDir = path.join(CLUSTER_DIR, "qc");
  const qcFiles = readdirSync(qcDir).filter((f) => f.endsWith(".json"));

  it("has at least one QC artifact on disk", () => {
    expect(qcFiles.length).toBeGreaterThan(0);
  });

  it.each(qcFiles)("validates %s against qcResultSchema", (file) => {
    const raw = readJson<QcResult>(qcDir, file);
    const result = validateQcResult(raw);
    expect(result.success).toBe(true);
  });

  it.each(qcFiles)("has a qcRunId in %s matching its file name", (file) => {
    const raw = readJson<QcResult>(qcDir, file);
    expect(`${raw.qcRunId}.json`).toBe(file);
  });

  it.each(qcFiles)("marks blocksDelivery false only when status is 'passed' in %s", (file) => {
    const raw = readJson<QcResult>(qcDir, file);
    if (raw.status === "passed") {
      expect(raw.policyDecision.blocksDelivery).toBe(false);
      expect(raw.findings).toEqual([]);
    } else {
      expect(raw.policyDecision.blocksDelivery).toBe(true);
    }
  });

  it.each(qcFiles)("sets allProvidersFailed and a failure providerAttempt only when status is 'failed' in %s", (file) => {
    const raw = readJson<QcResult>(qcDir, file);
    if (raw.status === "failed") {
      expect(raw.allProvidersFailed).toBe(true);
      expect(raw.providerAttempt?.status).toBe("failure");
    } else {
      expect(raw.allProvidersFailed).toBeUndefined();
    }
  });

  it("every finding on a 'findings' run belongs to the run and has a unique findingId", () => {
    for (const file of qcFiles) {
      const raw = readJson<QcResult>(qcDir, file);
      if (raw.status !== "findings") continue;
      expect(raw.findings.length).toBeGreaterThan(0);
      const ids = raw.findings.map((f) => f.findingId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe("POL-516 QC repair packet manifest", () => {
  const manifestPath = path.join(CLUSTER_DIR, "qc", "repair-rounds", "1", "repair-packets.json");
  const manifest = readJson<QcRepairPacketManifest>(manifestPath);

  it("validates against qcRepairPacketManifestSchema", () => {
    const result = validateRepairPacketManifest(manifest);
    expect(result.success).toBe(true);
  });

  it("targets cluster POL-516 round 1 with no compiled packets", () => {
    expect(manifest.clusterId).toBe("POL-516");
    expect(manifest.round).toBe(1);
    expect(manifest.packets).toEqual([]);
  });

  it("references a QC run id that has a corresponding artifact on disk", () => {
    for (const qcRunId of manifest.sourceQcRunIds) {
      const artifactPath = path.join(CLUSTER_DIR, "qc", `${qcRunId}.json`);
      expect(() => readFileSync(artifactPath, "utf-8")).not.toThrow();
    }
  });
});

describe("POL-516 POL-522 worker packet", () => {
  const packetPath = path.join(
    CLUSTER_DIR,
    "packets",
    "POL-522-507ef205-e8e4-41ba-9943-f974753ab0d7.json",
  );
  const packet = readJson<Record<string, any>>(packetPath);

  it("has consistent run/cluster/child identifiers", () => {
    expect(packet.run_id).toBe("polaris-run-pol-516-2026-07-09-001");
    expect(packet.cluster_id).toBe("POL-516");
    expect(packet.active_child).toBe("POL-522");
  });

  it("derives role_context from worker_role via roleContextForWorkerRole", () => {
    expect(packet.worker_role).toBe("impl");
    expect(packet.role_context).toEqual(roleContextForWorkerRole(packet.worker_role));
  });

  it("declares a non-empty allowed_scope and validation_commands", () => {
    expect(Array.isArray(packet.instructions.allowed_scope)).toBe(true);
    expect(packet.instructions.allowed_scope.length).toBeGreaterThan(0);
    expect(Array.isArray(packet.instructions.validation_commands)).toBe(true);
    expect(packet.instructions.validation_commands).toContain("npm test");
  });

  it("points result_file_contract at the results directory for this run", () => {
    expect(packet.result_file_contract.result_file).toContain(
      "/results/POL-522-507ef205-e8e4-41ba-9943-f974753ab0d7.json",
    );
    expect(packet.result_file_contract.result_required_fields.cluster_id).toBe("POL-516");
  });

  it("prohibits writes to taskchain/cluster/runs artifact directories", () => {
    expect(packet.prohibited_write_paths).toEqual(
      expect.arrayContaining([".taskchain_artifacts/", ".polaris/clusters/", ".polaris/runs/"]),
    );
  });
});

describe("POL-516 closeout librarian packet and result", () => {
  const packet = readJson<CloseoutLibrarianPacket>(
    CLUSTER_DIR,
    "packets",
    "librarian-packet-cc9da8a7-6f87-4cc4-9db6-bd648bf14dc5.json",
  );
  const result = readJson<CloseoutLibrarianResult>(
    CLUSTER_DIR,
    "results",
    "librarian-cc9da8a7-6f87-4cc4-9db6-bd648bf14dc5.json",
  );

  it("packet passes validateCloseoutLibrarianPacket with no errors", () => {
    expect(validateCloseoutLibrarianPacket(packet)).toEqual([]);
  });

  it("result passes validateCloseoutLibrarianResult with no errors", () => {
    expect(validateCloseoutLibrarianResult(result)).toEqual([]);
  });

  it("checkLibrarianResultGate allows finalize to proceed for a successful result", () => {
    expect(checkLibrarianResultGate(result)).toBeNull();
  });

  it("shares the same dispatch_id, run_id, and cluster_id between packet and result", () => {
    expect(result.dispatch_id).toBe(packet.dispatch_id);
    expect(result.run_id).toBe(packet.run_id);
    expect(result.cluster_id).toBe(packet.cluster_id);
  });

  it("lists all six completed children in the packet", () => {
    expect(packet.completed_children.sort()).toEqual(
      ["POL-517", "POL-518", "POL-519", "POL-520", "POL-521", "POL-522"].sort(),
    );
  });

  it("only records commit_sha and changed_files for children with completed_children entries in the packet", () => {
    const childrenWithCommits = packet.child_summaries.filter((c) => c.commit_sha !== null);
    expect(childrenWithCommits.map((c) => c.child_id).sort()).toEqual(["POL-521", "POL-522"].sort());
    for (const child of childrenWithCommits) {
      expect(child.changed_files.length).toBeGreaterThan(0);
    }
  });
});

describe("POL-516 child result packets", () => {
  const resultsDir = path.join(CLUSTER_DIR, "results");
  const simpleResultChildren = ["POL-517", "POL-518", "POL-519", "POL-520"];

  it.each(simpleResultChildren)("%s result is done with a passing validation list and commit", (childId) => {
    const result = readJson<Record<string, any>>(resultsDir, `${childId}.json`);
    expect(result.run_id).toBe("polaris-run-pol-516-2026-07-09-001");
    expect(result.cluster_id).toBe("POL-516");
    expect(result.child_id).toBe(childId);
    expect(result.status).toBe("done");
    expect(Array.isArray(result.validation.passed)).toBe(true);
    expect(result.validation.passed.length).toBeGreaterThan(0);
    expect(typeof result.commit).toBe("string");
    expect(result.commit.length).toBeGreaterThan(0);
  });

  it("POL-521 result includes an npm run lint validation step", () => {
    const result = readJson<Record<string, any>>(
      resultsDir,
      "POL-521-0f3159b8-9ad3-471f-98ca-a6789a6b5e49.json",
    );
    expect(result.child_id).toBe("POL-521");
    expect(result.validation.passed).toContain("npm run lint");
    expect(result.commit).toBe("fd3af4014dda191f6d91ed46cda288fdc53c28d3");
  });

  it("POL-522 compact result packet reports success with the packet's expected commit", () => {
    const result = readJson<Record<string, any>>(
      resultsDir,
      "POL-522-507ef205-e8e4-41ba-9943-f974753ab0d7.json",
    );
    expect(result.run_id).toBe("polaris-run-pol-516-2026-07-09-001");
    expect(result.child_id).toBe("POL-522");
    expect(result.status).toBe("success");
    expect(result.commit).toBe("87db39778dbb46ca9a1363d107e82994e7e5a0fc");
    expect(result.validation.passed).toContain("npm run build");
  });

  it("every child listed as commits in cluster-state.json has a corresponding result artifact", () => {
    const state = readJson<ClusterState>(CLUSTER_DIR, "cluster-state.json");
    for (const [childId, pointer] of Object.entries(state.result_pointers)) {
      const fileName = path.basename(pointer);
      expect(() => readFileSync(path.join(resultsDir, fileName), "utf-8")).not.toThrow();
      expect(state.commits[childId]).toBeTruthy();
    }
  });
});

describe("POL-516 state.json (CurrentState)", () => {
  const state = readJson<CurrentState & Record<string, any>>(CLUSTER_DIR, "state.json");

  it("reports the run as complete with no open children", () => {
    expect(state.schema_version).toBe("1.0");
    expect(state.run_id).toBe("polaris-run-pol-516-2026-07-09-001");
    expect(state.cluster_id).toBe("POL-516");
    expect(state.active_child).toBe("");
    expect(state.open_children).toEqual([]);
    expect(state.completed_children.sort()).toEqual(
      ["POL-517", "POL-518", "POL-519", "POL-520", "POL-521", "POL-522"].sort(),
    );
  });

  it("keeps context_budget consistent with the number of completed children", () => {
    expect(state.context_budget.children_completed).toBe(state.completed_children.length);
    expect(state.context_budget.max_children_per_session).toBe(1);
  });

  it("agrees with cluster-state.json on the QC repair-loop terminal outcome and manifest path", () => {
    const clusterState = readJson<ClusterState>(CLUSTER_DIR, "cluster-state.json");
    expect(state.qc_repair_loop.terminal_outcome).toBe(clusterState.qc_repair_outcome);
    expect(state.qc_repair_loop.manifest_path).toBe(
      clusterState.qc_repair_manifests?.[state.qc_repair_loop.current_round],
    );
  });

  it("records the last commit matching the POL-522 result artifact commit", () => {
    const compactResult = readJson<Record<string, any>>(
      CLUSTER_DIR,
      "results",
      "POL-522-507ef205-e8e4-41ba-9943-f974753ab0d7.json",
    );
    expect(state.last_commit).toBe(compactResult.commit);
  });
});

describe("POL-516 map artifacts (.polaris/map)", () => {
  const fileRoutes = readJson<Record<string, FileRouteEntry>>(MAP_DIR, "file-routes.json");
  const index = readJson<AtlasIndex>(MAP_DIR, "index.json");

  const addedRoutes = [
    "src/autoresearch/sol-run-health-bridge.test.ts",
    "src/autoresearch/sol-run-health-bridge.ts",
    "src/finalize/pol-509-regression.test.ts",
    "src/medic/POLARIS.md",
  ];

  it.each(addedRoutes)("file-routes.json has a well-formed FileRouteEntry for %s", (routePath) => {
    const entry = fileRoutes[routePath];
    expect(entry).toBeDefined();
    expect(entry.confidence).toBeGreaterThanOrEqual(0);
    expect(entry.confidence).toBeLessThanOrEqual(1);
    expect(["indexed", "tracked-not-indexed", "needs-review"]).toContain(entry.classification);
    expect(Array.isArray(entry.tags)).toBe(true);
    expect(() => new Date(entry.last_updated).toISOString()).not.toThrow();
  });

  it("has a matching entry for each added route in both file-routes.json and index.json", () => {
    for (const routePath of addedRoutes) {
      expect(index.entries[routePath]).toEqual(fileRoutes[routePath]);
    }
  });

  it("index.json file_count matches the number of entries", () => {
    expect(index.file_count).toBe(Object.keys(index.entries).length);
  });

  it("index.json instructionCoverage matches computeInstructionCoverage(entries)", () => {
    expect(index.instructionCoverage).toEqual(computeInstructionCoverage(index.entries));
  });

  it("src/medic/POLARIS.md is indexed with an instructionFile pointing at itself", () => {
    const entry = fileRoutes["src/medic/POLARIS.md"];
    expect(entry.classification).toBe("indexed");
    expect(entry.instructionFile).toBe("src/medic/POLARIS.md");
  });

  it("the two new test files are tagged as tests for their domain", () => {
    expect(fileRoutes["src/autoresearch/sol-run-health-bridge.test.ts"].tags).toEqual(
      expect.arrayContaining(["autoresearch", "test"]),
    );
    expect(fileRoutes["src/finalize/pol-509-regression.test.ts"].tags).toEqual(
      expect.arrayContaining(["finalize", "test"]),
    );
  });
});