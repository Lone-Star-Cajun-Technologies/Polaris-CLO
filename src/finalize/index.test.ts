import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { runQcAtTrigger, runQcRepairLoop } from "../qc/index.js";
import { runFinalize } from "./index.js";
import { readRunHealthReport } from "../run-health/index.js";
import type { QcResult, QcFinding } from "../qc/types.js";
import type { QcRepairLoopResult } from "../qc/repair-loop.js";

vi.mock("../qc/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../qc/index.js")>();
  return {
    ...actual,
    runQcAtTrigger: vi.fn(),
    runQcRepairLoop: vi.fn(),
  };
});

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-finalize-medic-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-c", "init.defaultBranch=main", "init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function writeCanonicalState(dir: string, clusterId: string): string {
  const stateFile = join(dir, ".polaris", "clusters", clusterId, "state.json");
  mkdirSync(join(dir, ".polaris", "clusters", clusterId), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        schema_version: "1.0",
        run_id: "test-finalize-medic-001",
        cluster_id: clusterId,
        active_child: "",
        completed_children: ["POL-9"],
        open_children: [],
        step_cursor: "CLUSTER-COMPLETE",
        context_budget: { children_completed: 1 },
        status: "complete",
        next_open_child: null,
      },
      null,
      2,
    ),
  );
  return stateFile;
}

function writeClusterArtifacts(dir: string, clusterId: string): void {
  const clusterDir = join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(join(clusterDir, "packets"), { recursive: true });
  mkdirSync(join(clusterDir, "results"), { recursive: true });
  mkdirSync(join(dir, ".polaris", "runs"), { recursive: true });
  writeFileSync(
    join(clusterDir, "cluster-state.json"),
    JSON.stringify({
      schema_version: "1.0",
      cluster_id: clusterId,
      state_generation: 1,
      child_states: [],
      claim_metadata: {},
      packet_pointers: {},
      result_pointers: {},
      validation_results: {},
      commits: {},
      tracker_mutations: {},
      blockers: [],
      qc_runs: {},
    }),
  );
  writeFileSync(join(clusterDir, "clusters.json"), "{}");
  writeFileSync(join(clusterDir, "packets", "packet.json"), "{}");
  writeFileSync(join(clusterDir, "results", "result.json"), "{}");
  writeFileSync(join(dir, ".polaris", "runs", "ledger.jsonl"), "{}\n");
}

function writeAtlas(dir: string): void {
  const mapDir = join(dir, ".polaris", "map");
  mkdirSync(mapDir, { recursive: true });
  for (const file of ["file-routes.json", "needs-review.json", "exemptions.json", "atlas-index.json"]) {
    writeFileSync(join(mapDir, file), "{}");
  }
}

function stageFile(dir: string, relativePath: string, content = "test\n"): void {
  const fullPath = join(dir, relativePath);
  const dirPart = relativePath.includes("/") ? relativePath.split("/").slice(0, -1).join("/") : ".";
  mkdirSync(join(dir, dirPart), { recursive: true });
  writeFileSync(fullPath, content);
  execFileSync("git", ["add", relativePath], { cwd: dir, stdio: "pipe" });
}

function makeFinding(overrides: Partial<QcFinding> & { findingId: string; severity: QcFinding["severity"]; title: string }): QcFinding {
  const { findingId, severity, title, ...rest } = overrides;
  return {
    findingId,
    severity,
    title,
    category: "style",
    filePath: "src/impl.ts",
    fixAvailable: false,
    autofixEligible: false,
    attribution: { confidence: "low", reason: "provider-uncertain", childId: "POL-9" },
    status: "open",
    routingDecision: "follow-up",
    ...rest,
  };
}

function makeMedicReferralResult(clusterId: string): {
  result: { trigger: "completed-cluster"; results: QcResult[]; action: "block"; summary: string };
  repairLoopResult: QcRepairLoopResult;
} {
  const now = new Date().toISOString();
  const baseResult: QcResult = {
    schemaVersion: "1.0",
    qcRunId: `qc-${clusterId}-1`,
    runId: "test-finalize-medic-001",
    clusterId,
    trigger: "completed-cluster",
    provider: "test",
    providerMode: "local",
    startedAt: now,
    completedAt: now,
    status: "findings",
    findings: [makeFinding({ findingId: "f1", severity: "medium", title: "autonomous repair", routingDecision: "repair-worker" })],
    rawArtifactPaths: [],
    parserVersion: "test",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: false,
      routedToRepair: true,
      summary: "test",
    },
  };
  const result = {
    trigger: "completed-cluster" as const,
    results: [baseResult],
    action: "block" as const,
    summary: "blocked",
  };
  const repairLoopResult: QcRepairLoopResult = {
    outcome: "medic-referral",
    rounds_completed: 1,
    final_qc_results: result.results,
    loop_state: {
      current_round: 1,
      max_rounds: 1,
      source_qc_run_ids: [`qc-${clusterId}-1`],
      manifest_path: null,
      pending_packet_ids: [],
      completed_packet_ids: [],
      rerun_requested: false,
      rerun_qc_run_ids: {},
      terminal_outcome: "medic-referral",
      initiated_at: now,
      updated_at: now,
    },
    summary: "repair dispatch failed — Medic referral",
  };
  return { result, repairLoopResult };
}

describe("runFinalize records repair-loop outcome symptoms", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    vi.mocked(runQcAtTrigger).mockReset();
    vi.mocked(runQcRepairLoop).mockReset();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("records a qc-repair-dispatch-failure symptom on a medic-referral outcome", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify(
        {
          version: "1.0",
          canon: { checkOnFinalize: false },
          qc: {
            enabled: true,
            defaultTrigger: "completed-cluster",
            providers: {
              test: { name: "test", mode: "local" },
            },
            repairRouting: "route",
            maxRepairRounds: 1,
          },
        },
        null,
        2,
      ),
    );

    const { result, repairLoopResult } = makeMedicReferralResult(clusterId);
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(result);
    vi.mocked(runQcRepairLoop).mockResolvedValueOnce(repairLoopResult);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).rejects.toThrow("process.exit called");

    const report = readRunHealthReport("test-finalize-medic-001", testDir);
    expect(report).not.toBeNull();
    expect(report?.symptoms.some((s) => s.code === "qc-repair-dispatch-failure")).toBe(true);

    exitSpy.mockRestore();
  });
});
