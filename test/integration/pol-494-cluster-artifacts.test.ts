import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { readClusterStateSync } from "../../src/cluster-state/store.js";
import { LocalGraph } from "../../src/tracker/local-graph.js";
import { validateQcResult, validateRepairPacketManifest } from "../../src/qc/schemas.js";
import { getGitignorePatterns } from "../../src/finalize/artifact-policy.js";

const repoRoot = process.cwd();
const clusterId = "POL-494";
const clusterDir = path.join(repoRoot, ".polaris", "clusters", clusterId);

function readJson(...segments: string[]): any {
  return JSON.parse(readFileSync(path.join(clusterDir, ...segments), "utf-8"));
}

describe(".gitignore runtime artifact patterns", () => {
  const gitignoreContent = readFileSync(path.join(repoRoot, ".gitignore"), "utf-8");

  it("contains every pattern produced by getGitignorePatterns()", () => {
    for (const pattern of getGitignorePatterns()) {
      expect(gitignoreContent).toContain(pattern);
    }
  });

  it("retains the run-state and tmp scratch patterns added for POL-494/POL-499", () => {
    expect(gitignoreContent).toContain(".polaris/runs/current-state.json");
    expect(gitignoreContent).toContain(".polaris/runs/run-report.md");
    expect(gitignoreContent).toContain(".polaris/tmp/**");
  });

  it("does not drop pre-existing legacy run artifact patterns", () => {
    expect(gitignoreContent).toContain(".polaris/runs/mutation-queue.json");
    expect(gitignoreContent).toContain(".polaris/runs/current-state.pre-pol-198.json");
    expect(gitignoreContent).toContain(".polaris/runs/evo-run-archive/**");
  });
});

describe("POL-494 cluster-state.json", () => {
  const state = readClusterStateSync(clusterId, repoRoot);
  const childIds = ["POL-495", "POL-496", "POL-497", "POL-498", "POL-499", "POL-540", "POL-541", "POL-544"];

  it("loads and normalizes without throwing", () => {
    expect(state).not.toBeNull();
  });

  it("reports the expected top-level identifiers and generation", () => {
    expect(state?.schema_version).toBe("1.0");
    expect(state?.cluster_id).toBe(clusterId);
    expect(state?.state_generation).toBe(34);
    expect(state?.delivery_branch).toBe("pol-494-delivery");
    expect(state?.base_branch).toBe("main");
  });

  it("marks every child done with a recorded commit", () => {
    expect(state?.child_states).toHaveLength(childIds.length);
    for (const child of state?.child_states ?? []) {
      expect(child.status).toBe("done");
      expect(child.commit).toBeTruthy();
      // commits map must agree with the per-child commit recorded on child_states
      expect(state?.commits[child.id]).toBe(child.commit);
    }
  });

  it("has passed validation results for every child", () => {
    for (const id of childIds) {
      expect(state?.validation_results[id]).toEqual({ passed: true, output: "passed" });
    }
  });

  it("has a packet and result pointer for every child", () => {
    for (const id of childIds) {
      expect(state?.packet_pointers[id]).toBeTruthy();
      expect(state?.result_pointers[id]).toBeTruthy();
    }
  });

  it("records qc repair manifests for both repair rounds and a medic-referral outcome", () => {
    expect(state?.qc_repair_manifests).toEqual({
      1: expect.stringContaining(path.join("qc", "repair-rounds", "1", "repair-packets.json")),
      2: expect.stringContaining(path.join("qc", "repair-rounds", "2", "repair-packets.json")),
    });
    expect(state?.qc_repair_outcome).toBe("medic-referral");
  });

  it("records qc run pointers with the expected statuses and provider", () => {
    const qcRuns = state?.qc_runs ?? {};
    expect(Object.keys(qcRuns)).toHaveLength(4);
    expect(qcRuns["coderabbit-1783813556239"]?.status).toBe("findings");
    expect(qcRuns["coderabbit-1783818427444"]?.status).toBe("findings");
    expect(qcRuns["coderabbit-1783830316317"]?.status).toBe("failed");
    expect(qcRuns["coderabbit-1783832990101"]?.status).toBe("skipped");
    for (const pointer of Object.values(qcRuns)) {
      expect(pointer.provider).toBe("coderabbit");
      expect(pointer.availability).toBe("available");
    }
  });

  it("returns null for a cluster that has no cluster-state.json", () => {
    expect(readClusterStateSync("POL-DOES-NOT-EXIST", repoRoot)).toBeNull();
  });
});

describe("POL-494 clusters.json", () => {
  it("loads as a valid v2 execution graph via LocalGraph", async () => {
    const graph = await LocalGraph.load(clusterId, repoRoot);
    expect(graph.fullGraph.schemaVersion).toBe("v2");
    expect(graph.fullGraph.activeCluster).toBe(clusterId);
  });

  it("exposes the active cluster with its ordered children", async () => {
    const graph = await LocalGraph.load(clusterId, repoRoot);
    const active = graph.getActiveCluster();
    expect(active.cluster_root).toBe(clusterId);
    expect(active.children).toEqual(
      expect.arrayContaining(["POL-544", "POL-541", "POL-540", "POL-499", "POL-498", "POL-497", "POL-496", "POL-495"]),
    );
    expect(active.children).toHaveLength(8);
  });

  it("resolves node metadata for the cluster root and a child", async () => {
    const graph = await LocalGraph.load(clusterId, repoRoot);
    expect(graph.getNode(clusterId)?.title).toBe("IMPLEMENT: Provider Routing Evidence");
    expect(graph.getNode("POL-544")?.status).toBe("Backlog");
    expect(graph.getNode("POL-493")?.status).toBe("Done");
  });

  it("resolves declared dependency ordering", async () => {
    const graph = await LocalGraph.load(clusterId, repoRoot);
    expect(graph.getDependencies("POL-499")).toEqual(["POL-497"]);
    expect(graph.getDependencies("POL-497")).toEqual(["POL-496"]);
    expect(graph.getDependencies("POL-496")).toEqual(["POL-495"]);
    expect(graph.getDependencies("POL-495")).toEqual([]);
  });
});

describe("POL-494 worker packets", () => {
  const workerPackets: Array<{ file: string; activeChild: string; runId: string }> = [
    { file: "POL-495-016647c6-be5c-45f9-ba71-22b841003013.json", activeChild: "POL-495", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-496-c17cd224-5c2d-4619-822e-541a067ff66b.json", activeChild: "POL-496", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-497-59dad3bd-2638-4991-9509-0e2478c4c34f.json", activeChild: "POL-497", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-497-9b6288a6-143c-4d5f-badd-11c6976b8423.json", activeChild: "POL-497", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-497-bc897e36-36a5-487a-85f9-c06257b653f3.json", activeChild: "POL-497", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-498-90f12f49-4ec5-40e7-8f12-90a3dc0aa70f.json", activeChild: "POL-498", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-499-845b9610-70ef-4c3f-8081-3478a74dd146.json", activeChild: "POL-499", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-499-e2f624af-4e27-4a19-bf5b-28ff24cbcce0.json", activeChild: "POL-499", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-540-5cfe6fb2-05e7-4dd2-a4a3-89b6aa2c5cae.json", activeChild: "POL-540", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-540-9fa4a69d-48b4-4caa-9d33-c50d0c811a0b.json", activeChild: "POL-540", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-541-d971d900-c2a9-4532-9595-a524db49a528.json", activeChild: "POL-541", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-541-f4f172c6-1893-4519-8f8a-8a8d398fcf3e.json", activeChild: "POL-541", runId: "polaris-run-pol-494-2026-07-11-001" },
    { file: "POL-544-c2d78c20-ea52-45bf-b1ce-14e49097476c.json", activeChild: "POL-544", runId: "polaris-run-pol-494-2026-07-12-001" },
    { file: "POL-544-da3811bd-201f-4499-b2ba-010e034f44a7.json", activeChild: "POL-544", runId: "polaris-run-pol-494-2026-07-12-001" },
  ];

  it.each(workerPackets)(
    "$file declares a well-formed worker packet contract for $activeChild",
    ({ file, activeChild, runId }) => {
      const packet = readJson("packets", file);

      expect(packet.schema_version).toBe("2.1");
      expect(packet.worker_role).toBe("impl");
      expect(packet.cluster_id).toBe(clusterId);
      expect(packet.active_child).toBe(activeChild);
      expect(packet.run_id).toBe(runId);
      expect(packet.return_contract).toEqual([
        "child_id",
        "status",
        "commit",
        "validation",
        "next_recommended_action",
      ]);
      expect(packet.result_file_contract.result_file.endsWith(`results/${file}`)).toBe(true);
      expect(packet.prohibited_write_paths).toEqual([
        ".taskchain_artifacts/",
        ".polaris/clusters/",
        ".polaris/runs/",
        "**/telemetry.jsonl",
      ]);
      expect(packet.role_context.prohibited_actions).toEqual(
        expect.arrayContaining(["polaris-loop-dispatch", "polaris-loop-continue", "modify-cluster-plan"]),
      );
    },
  );

  it("scopes each packet's allowed_scope to files declared in the packet instructions", () => {
    const packet = readJson("packets", "POL-495-016647c6-be5c-45f9-ba71-22b841003013.json");
    expect(packet.instructions.allowed_scope).toEqual(
      expect.arrayContaining(["src/config/schema.ts", "src/config/validator.ts"]),
    );
    expect(packet.instructions.validation_commands).toEqual([
      "npm run build",
      "npm test",
      "npx vitest run src/config",
    ]);
  });

  it("loads the closeout-librarian packet with a distinct schema from worker packets", () => {
    const librarianPacket = readJson("packets", "librarian-packet-07212f87-f579-48f7-9050-352e27d0ec0d.json");

    expect(librarianPacket.schema_version).toBe("1.0");
    expect(librarianPacket.role).toBe("closeout-librarian");
    expect(librarianPacket.worker_role).toBeUndefined();
    expect(librarianPacket.cluster_id).toBe(clusterId);
    expect(librarianPacket.completed_children).toEqual(["POL-541", "POL-499"]);
    expect(librarianPacket.result_path.endsWith("results/librarian-07212f87-f579-48f7-9050-352e27d0ec0d.json")).toBe(true);
  });
});

describe("POL-494 sealed result: POL-495", () => {
  const result = readJson("results", "POL-495-016647c6-be5c-45f9-ba71-22b841003013.json");

  it("matches the fields recorded by the runtime for a successful worker", () => {
    expect(result).toEqual({
      run_id: "polaris-run-pol-494-2026-07-11-001",
      child_id: "POL-495",
      status: "success",
      commit: "a04cabc3477047be12dab9015e89ed6ee4902370",
      validation: "passed",
    });
  });

  it("agrees with the commit recorded in cluster-state.json for the same child", () => {
    const state = readClusterStateSync(clusterId, repoRoot);
    expect(result.commit).toBe(state?.commits["POL-495"]);
  });
});

describe("POL-494 QC run artifacts", () => {
  const qcFiles = [
    "coderabbit-1783813556239.json",
    "coderabbit-1783818427444.json",
    "coderabbit-1783830316317.json",
    "coderabbit-1783832990101.json",
  ];

  it.each(qcFiles)("%s validates against the normalized QC result schema", (file) => {
    const raw = readJson("qc", file);
    const validation = validateQcResult(raw);
    expect(validation.success).toBe(true);
  });

  it("captures a findings run with all-provider success", () => {
    const raw = readJson("qc", "coderabbit-1783813556239.json");
    expect(raw.status).toBe("findings");
    expect(raw.findings).toHaveLength(8);
    expect(raw.policyDecision.blocksDelivery).toBe(true);
    expect(raw.providerAttempt.status).toBe("success");
  });

  it("captures a failed provider run with allProvidersFailed and a failure reason", () => {
    const raw = readJson("qc", "coderabbit-1783830316317.json");
    expect(raw.status).toBe("failed");
    expect(raw.allProvidersFailed).toBe(true);
    expect(raw.findings).toHaveLength(0);
    expect(raw.providerAttempt.status).toBe("failure");
    expect(raw.providerAttempt.failureReason).toBe("unusable-output");
  });

  it("captures a skipped provider run without requiring operator review", () => {
    const raw = readJson("qc", "coderabbit-1783832990101.json");
    expect(raw.status).toBe("skipped");
    expect(raw.providerAttempt.status).toBe("skipped");
    expect(raw.providerAttempt.failureReason).toBe("rate-limited");
    expect(raw.policyDecision.requiresOperatorReview).toBe(false);
  });

  it("rejects a QC artifact that is missing required fields", () => {
    const raw = readJson("qc", "coderabbit-1783813556239.json");
    const { findings: _findings, ...withoutFindings } = raw;
    const validation = validateQcResult(withoutFindings);
    expect(validation.success).toBe(false);
  });
});

describe("POL-494 QC repair-round manifests", () => {
  it("round 1 manifest validates and matches the sourcing QC run", () => {
    const manifest = readJson("qc", "repair-rounds", "1", "repair-packets.json");
    const validation = validateRepairPacketManifest(manifest);
    expect(validation.success).toBe(true);
    expect(manifest.clusterId).toBe(clusterId);
    expect(manifest.round).toBe(1);
    expect(manifest.sourceQcRunIds).toEqual(["coderabbit-1783813556239"]);
    expect(manifest.packets).toHaveLength(4);
    for (const packet of manifest.packets) {
      expect(packet.clusterId).toBe(clusterId);
      expect(packet.round).toBe(1);
      expect(packet.packetId).toMatch(/^pkt-POL-494-r1-\d{3}$/);
    }
  });

  it("round 2 manifest validates and routes high-severity findings to operator review", () => {
    const manifest = readJson("qc", "repair-rounds", "2", "repair-packets.json");
    const validation = validateRepairPacketManifest(manifest);
    expect(validation.success).toBe(true);
    expect(manifest.round).toBe(2);
    expect(manifest.sourceQcRunIds).toEqual(["coderabbit-1783818427444"]);
    expect(manifest.packets).toHaveLength(7);

    const terminalCliPacket = manifest.packets.find((p: { allowedScope: string[] }) =>
      p.allowedScope.includes("src/loop/adapters/terminal-cli.ts"),
    );
    expect(terminalCliPacket).toBeDefined();
    expect(terminalCliPacket.severityFloor).toBe("high");
    expect(terminalCliPacket.routingTarget).toBe("operator-review");
    expect(terminalCliPacket.medic).toBe(true);
  });

  it("references qc run ids that are recorded in cluster-state.json", () => {
    const state = readClusterStateSync(clusterId, repoRoot);
    const round1 = readJson("qc", "repair-rounds", "1", "repair-packets.json");
    const round2 = readJson("qc", "repair-rounds", "2", "repair-packets.json");

    for (const runId of [...round1.sourceQcRunIds, ...round2.sourceQcRunIds]) {
      expect(state?.qc_runs?.[runId]).toBeDefined();
    }
  });

  it("resolves the on-disk repair manifest paths referenced by qc_repair_manifests", () => {
    for (const round of [1, 2]) {
      const manifestPath = path.join(clusterDir, "qc", "repair-rounds", String(round), "repair-packets.json");
      expect(existsSync(manifestPath)).toBe(true);
    }
  });
});