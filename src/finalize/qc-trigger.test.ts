import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Mock external finalize steps so these tests focus on QC trigger wiring.
vi.mock("./steps/07-push.js", () => ({ stepPush: vi.fn() }));
vi.mock("./steps/08-create-pr.js", () => ({ stepCreatePr: vi.fn() }));
vi.mock("./steps/11-update-linear.js", () => ({ stepUpdateLinear: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./steps/12-archive.js", () => ({ stepArchive: vi.fn() }));
vi.mock("../qc/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../qc/index.js")>();
  return {
    ...actual,
    runQcAtTrigger: vi.fn(),
    runQcRepairLoop: vi.fn(),
  };
});

import { runQcAtTrigger, runQcRepairLoop } from "../qc/index.js";
import { stepCreatePr } from "./steps/08-create-pr.js";
import { runFinalize } from "./index.js";
import type { QcFinding, QcResult } from "../qc/types.js";
import type { QcRepairLoopResult } from "../qc/repair-loop.js";

function makeTestDir(): string {
  const dir = join(tmpdir(), `polaris-finalize-qc-${Date.now()}`);
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
    JSON.stringify({
      schema_version: "1.0",
      run_id: "test-finalize-qc-001",
      cluster_id: clusterId,
      active_child: "",
      completed_children: ["POL-9"],
      open_children: [],
      step_cursor: "CLUSTER-COMPLETE",
      context_budget: { children_completed: 1 },
      status: "complete",
      next_open_child: null,
      qc_repair_loop: {
        current_round: 1,
        max_rounds: 2,
        source_qc_run_ids: [],
        manifest_path: null,
        pending_packet_ids: [],
        completed_packet_ids: [],
        rerun_requested: false,
        rerun_qc_run_ids: {},
        terminal_outcome: "pass",
        initiated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }, null, 2),
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

function makeFinding(
  overrides: Partial<QcFinding> & { findingId: string; severity: QcFinding["severity"]; title: string },
): QcFinding {
  return {
    findingId: overrides.findingId,
    severity: overrides.severity,
    title: overrides.title,
    category: "style",
    filePath: "src/impl.ts",
    fixAvailable: false,
    autofixEligible: false,
    attribution: { confidence: "low", reason: "provider-uncertain", childId: "POL-9" },
    status: "open",
    routingDecision: "follow-up",
    ...overrides,
  };
}

function makeCompletedClusterResult(
  clusterId: string,
  action: "pass" | "block" | "follow-up",
  findings: QcFinding[] = [],
): {
  result: { trigger: "completed-cluster"; results: QcResult[]; action: typeof action; summary: string };
  repairLoopResult: QcRepairLoopResult;
} {
  const status = action === "pass" ? "passed" : "findings";
  const policyDecision = {
    blocksDelivery: action === "block",
    requiresOperatorReview: findings.some((f) => f.routingDecision === "operator-review"),
    routedToRepair: findings.some(
      (f) => f.routingDecision === "repair-worker" || f.routingDecision === "original-worker",
    ),
    summary: "test",
  };
  const result = {
    trigger: "completed-cluster" as const,
    results: [
      {
        schemaVersion: "1.0",
        qcRunId: `qc-${clusterId}-1`,
        runId: "test-finalize-qc-001",
        clusterId,
        trigger: "completed-cluster" as const,
        provider: "test",
        providerMode: "local" as const,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status,
        findings,
        rawArtifactPaths: [],
        parserVersion: "test",
        policyDecision,
      },
    ],
    action,
    summary: "test",
  };

  const terminalOutcome =
    action === "pass"
      ? "pass"
      : findings.some((f) => f.routingDecision === "repair-worker" || f.routingDecision === "original-worker")
        ? "pass"
        : findings.some((f) => f.routingDecision === "operator-review")
          ? "operator-review"
          : "no-repairable";

  const repairLoopResult: QcRepairLoopResult = {
    outcome: terminalOutcome,
    rounds_completed: 1,
    final_qc_results: result.results,
    loop_state: {
      current_round: 1,
      max_rounds: 1,
      source_qc_run_ids: [`qc-${clusterId}-1`],
      manifest_path: join(
        ".polaris",
        "clusters",
        clusterId,
        "qc",
        "repair-rounds",
        "1",
        "repair-packets.json",
      ),
      pending_packet_ids: [],
      completed_packet_ids: [],
      rerun_requested: false,
      rerun_qc_run_ids: {},
      terminal_outcome: terminalOutcome,
      initiated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    summary: `repair ${terminalOutcome}`,
  };

  return { result, repairLoopResult };
}

function makePrResult(clusterId: string): {
  trigger: "pr";
  results: QcResult[];
  action: "pass";
  summary: string;
} {
  return {
    trigger: "pr",
    results: [
      {
        schemaVersion: "1.0",
        qcRunId: `qc-${clusterId}-pr`,
        runId: "test-finalize-qc-001",
        clusterId,
        trigger: "pr",
        provider: "test",
        providerMode: "local",
        prUrl: "https://github.com/org/repo/pull/42",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: "passed",
        findings: [],
        rawArtifactPaths: [],
        parserVersion: "test",
        policyDecision: {
          blocksDelivery: false,
          requiresOperatorReview: false,
          routedToRepair: false,
          summary: "ok",
        },
      },
    ],
    action: "pass",
    summary: "ok",
  };
}

describe("runFinalize QC trigger integration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTestDir();
    vi.mocked(runQcAtTrigger).mockReset();
    vi.mocked(runQcRepairLoop).mockReset();
    vi.mocked(stepCreatePr).mockReset();
    vi.mocked(stepCreatePr).mockReturnValue("https://github.com/org/repo/pull/42");
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("runs completed-cluster QC before commit and PR QC after PR creation", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
        },
      }),
    );

    vi.mocked(runQcAtTrigger).mockResolvedValue({
      trigger: "completed-cluster",
      results: [],
      action: "pass",
      summary: "ok",
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    try {
      await runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true });
    } catch (err) {
      // process.exit throws in tests; ignore if it is our marker.
      if (!(err instanceof Error && err.message === "process.exit called")) throw err;
    } finally {
      exitSpy.mockRestore();
    }

    const calls = vi.mocked(runQcAtTrigger).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]![0].trigger).toBe("completed-cluster");
    expect(calls[0]![0].baseRef).toBe("main");
    expect(calls[1]![0].trigger).toBe("pr");
    expect(calls[1]![0].prUrl).toBe("https://github.com/org/repo/pull/42");
  });

  it("blocks finalize when completed-cluster QC returns block", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "block",
        },
      }),
    );

    vi.mocked(runQcAtTrigger).mockResolvedValue({
      trigger: "completed-cluster",
      results: [],
      action: "block",
      summary: "blocked",
    });

    let exitCode: number | null = null;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("process.exit called");
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).rejects.toThrow("process.exit called");

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("blocked finalize"));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("runs QC repair loop when completed-cluster QC blocks under route mode", async () => {
    const clusterId = "POL-6";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-6-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
          maxRepairRounds: 1,
        },
      }),
    );

    const blockedResult = {
      trigger: "completed-cluster" as const,
      results: [
        {
          schemaVersion: "1.0",
          qcRunId: "qc-1",
          runId: "test-finalize-qc-001",
          clusterId,
          trigger: "completed-cluster" as const,
          provider: "test",
          providerMode: "local" as const,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "findings" as const,
          findings: [],
          rawArtifactPaths: [],
          parserVersion: "test",
          policyDecision: {
            blocksDelivery: true,
            requiresOperatorReview: false,
            routedToRepair: true,
            summary: "blocked",
          },
        },
      ],
      action: "block" as const,
      summary: "blocked",
    };
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(blockedResult);
    vi.mocked(runQcRepairLoop).mockResolvedValueOnce({
      outcome: "pass",
      rounds_completed: 1,
      final_qc_results: blockedResult.results,
      loop_state: {
        current_round: 1,
        max_rounds: 1,
        source_qc_run_ids: ["qc-1"],
        manifest_path: join(testDir, ".polaris", "clusters", clusterId, "qc", "repair-rounds", "1", "repair-packets.json"),
        pending_packet_ids: [],
        completed_packet_ids: [],
        rerun_requested: false,
        rerun_qc_run_ids: { 1: ["qc-2"] },
        terminal_outcome: "pass",
        initiated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      summary: "repair pass",
    });
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce({
      trigger: "pr",
      results: [],
      action: "pass",
      summary: "ok",
    });

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(runQcRepairLoop)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runQcAtTrigger).mock.calls[0]?.[0].trigger).toBe("completed-cluster");

    exitSpy.mockRestore();
  });

  it("runs QC repair loop for follow-up action and proceeds when it reaches a trusted terminal state", async () => {
    const clusterId = "POL-7";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-7-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
          maxRepairRounds: 1,
        },
      }),
    );

    const { result, repairLoopResult } = makeCompletedClusterResult(
      clusterId,
      "follow-up",
      [makeFinding({ findingId: "f1", severity: "low", title: "low priority follow-up" })],
    );
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(result);
    vi.mocked(runQcRepairLoop).mockResolvedValueOnce(repairLoopResult);
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(makePrResult(clusterId));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(runQcRepairLoop)).toHaveBeenCalledTimes(1);
    const repairLoopCall = vi.mocked(runQcRepairLoop).mock.calls[0];
    expect(repairLoopCall?.[0].initialQcResults).toEqual(result.results);

    exitSpy.mockRestore();
  });

  it("reaches the operator-review terminal gate promptly when QC produces only operator-review findings", async () => {
    const clusterId = "POL-8";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-8-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
          maxRepairRounds: 1,
        },
      }),
    );

    const { result, repairLoopResult } = makeCompletedClusterResult(
      clusterId,
      "block",
      [
        makeFinding({
          findingId: "f1",
          severity: "high",
          title: "operator review required",
          routingDecision: "operator-review",
        }),
      ],
    );
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(result);
    vi.mocked(runQcRepairLoop).mockResolvedValueOnce(repairLoopResult);

    let exitCode: number | null = null;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("process.exit called");
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).rejects.toThrow("process.exit called");

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("operator-review"));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("dispatches only repair-worker packets in a mixed finding set and reaches a terminal pass", async () => {
    const clusterId = "POL-9";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-9-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
          maxRepairRounds: 1,
        },
      }),
    );

    const { result, repairLoopResult } = makeCompletedClusterResult(
      clusterId,
      "block",
      [
        makeFinding({
          findingId: "f1",
          severity: "medium",
          title: "autonomous repair",
          routingDecision: "repair-worker",
        }),
        makeFinding({
          findingId: "f2",
          severity: "high",
          title: "operator review required",
          routingDecision: "operator-review",
        }),
      ],
    );
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(result);
    vi.mocked(runQcRepairLoop).mockResolvedValueOnce(repairLoopResult);
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(makePrResult(clusterId));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).resolves.toBeUndefined();

    expect(vi.mocked(runQcRepairLoop)).toHaveBeenCalledTimes(1);
    const repairLoopCall = vi.mocked(runQcRepairLoop).mock.calls[0];
    const initialFindings = repairLoopCall?.[0].initialQcResults[0]?.findings ?? [];
    expect(initialFindings.some((f) => f.routingDecision === "repair-worker")).toBe(true);
    expect(initialFindings.some((f) => f.routingDecision === "operator-review")).toBe(true);

    exitSpy.mockRestore();
  });

  it("reports a clear blocking error when a repair-worker dispatch times out", async () => {
    const clusterId = "POL-10";
    const stateFile = writeCanonicalState(testDir, clusterId);
    execFileSync("git", ["checkout", "-b", "pol-10-delivery"], { cwd: testDir, stdio: "pipe" });
    writeAtlas(testDir);
    writeClusterArtifacts(testDir, clusterId);
    stageFile(testDir, "src/impl.ts", "export function impl() {}\n");

    writeFileSync(
      join(testDir, "polaris.config.json"),
      JSON.stringify({
        version: "1.0",
        qc: {
          enabled: true,
          defaultTrigger: "completed-cluster",
          providers: {
            test: { name: "test", mode: "local" },
          },
          repairRouting: "route",
          maxRepairRounds: 1,
          repairDispatchTimeoutMs: 10,
        },
      }),
    );

    const { result } = makeCompletedClusterResult(
      clusterId,
      "block",
      [
        makeFinding({
          findingId: "f1",
          severity: "medium",
          title: "autonomous repair",
          routingDecision: "repair-worker",
        }),
      ],
    );
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
        initiated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      summary: "repair dispatch timed out — Medic referral",
    };
    vi.mocked(runQcAtTrigger).mockResolvedValueOnce(result);
    vi.mocked(runQcRepairLoop).mockResolvedValueOnce(repairLoopResult);

    let exitCode: number | null = null;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("process.exit called");
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runFinalize({ repoRoot: testDir, stateFile, skipLibrarian: true }),
    ).rejects.toThrow("process.exit called");

    expect(exitCode).toBe(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("medic-referral"));

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});
