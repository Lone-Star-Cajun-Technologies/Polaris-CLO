/**
 * Integration tests for the QC repair loop orchestration.
 *
 * Covers:
 *   - Completed-cluster QC findings → repair packet manifest → repair worker dispatch → QC rerun → pass
 *   - Max rounds reached without passing
 *   - No repairable packets
 *   - All QC providers failed
 *   - Failed repair worker → Medic referral
 *   - Overlapping packet serialization (parallel vs. conflicting groups)
 *   - QC disabled (loop skipped)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  runQcRepairLoop,
  initRepairLoopState,
  partitionRepairPackets,
  DEFAULT_MAX_REPAIR_ROUNDS,
  type DispatchRepairWorkerFn,
  type RepairWorkerResult,
} from "./repair-loop.js";
import type { QcRepairPacket, QcRepairPacketManifest, QcResult } from "./types.js";
import type { QcConfig } from "../config/schema.js";
import type { QcProviderRegistry } from "./provider.js";
import { makeFinding, makeResult } from "./fixtures/repair-packets.js";
import type { QcOrchestratorResult } from "./orchestration.js";
import { readClusterStateSync } from "../cluster-state/store.js";

// Mock runQcAtTrigger to control rerun results without needing real providers.
vi.mock("./orchestration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./orchestration.js")>();
  return { ...actual, runQcAtTrigger: vi.fn() };
});
import { runQcAtTrigger } from "./orchestration.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeRepairable(overrides: Partial<QcRepairPacket> = {}): QcRepairPacket {
  return {
    packetId: `pkt-test-r1-001`,
    round: 1,
    clusterId: "POL-TEST",
    sourceQcRunIds: ["qc-run-1"],
    findingIds: ["f-1"],
    severityFloor: "medium",
    rootCauseHint: "categories=[style]; files=[src/foo.ts]; confidence=clear; severity=medium",
    allowedScope: ["src/foo.ts"],
    prohibitedScope: [],
    validationCommands: ["npm test"],
    routingTarget: "repair-worker",
    parallelGroup: "g-000",
    conflicts: [],
    medic: false,
    status: "pending",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeManifest(packets: QcRepairPacket[]): QcRepairPacketManifest {
  return {
    schemaVersion: "1.0",
    clusterId: "POL-TEST",
    round: 1,
    compiledAt: new Date().toISOString(),
    sourceQcRunIds: ["qc-run-1"],
    packets,
  };
}

function makeQcConfig(overrides: Partial<QcConfig> = {}): QcConfig {
  return {
    enabled: true,
    severityThresholds: { block: "high", repair: "medium", followUp: "low" },
    maxRepairRounds: 2,
    providers: {
      mock: { enabled: true, mode: "local", trigger: "completed-cluster" } as import("../config/schema.js").QcProviderConfig,
    },
    ...overrides,
  };
}

function makePassedQcResult(): QcOrchestratorResult {
  const passedResult = makeResult({ status: "passed", findings: [] });
  return { trigger: "completed-cluster", results: [passedResult], action: "pass", summary: "passed" };
}

function makeQcResultWithFindings(): QcResult {
  return makeResult({
    qcRunId: "qc-run-1",
    status: "findings",
    findings: [
      makeFinding({
        findingId: "f-1",
        severity: "medium",
        filePath: "src/foo.ts",
        attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-123" },
        routingDecision: "repair-worker",
        status: "open",
      }),
    ],
  });
}

const emptyRegistry = { get: () => undefined } as unknown as QcProviderRegistry;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runQcRepairLoop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `polaris-repair-loop-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.mocked(runQcAtTrigger).mockReset();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  });

  it("exits with qc-disabled when QC is not enabled", async () => {
    const config = makeQcConfig({ enabled: false });
    const dispatch: DispatchRepairWorkerFn = vi.fn();
    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [makeQcResultWithFindings()],
      dispatchRepairWorker: dispatch,
    });

    expect(result.outcome).toBe("qc-disabled");
    expect(result.rounds_completed).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes after one repair round when rerun passes", async () => {
    const config = makeQcConfig({ maxRepairRounds: 2 });

    // Mock the QC rerun to return a pass.
    vi.mocked(runQcAtTrigger).mockResolvedValue(makePassedQcResult());

    const dispatch: DispatchRepairWorkerFn = vi.fn().mockResolvedValue({
      packetId: "pkt-test-r1-001",
      status: "success",
    } as RepairWorkerResult);

    const packet = makeRepairable({ packetId: "pkt-test-r1-001" });
    const qcResult = makeQcResultWithFindings();

    // Pre-write the manifest so the loop can read it.
    const manifestDir = path.join(tmpDir, ".polaris", "clusters", "POL-TEST", "qc", "repair-rounds", "1");
    mkdirSync(manifestDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(manifestDir, "repair-packets.json"),
      JSON.stringify(makeManifest([packet]), null, 2),
      "utf-8",
    );

    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [qcResult],
      dispatchRepairWorker: dispatch,
      maxRounds: 2,
    });

    expect(result.outcome).toBe("pass");
    expect(result.rounds_completed).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("exits with no-repairable when manifest has no repair-worker packets and findings are follow-up only", async () => {
    const config = makeQcConfig();
    const dispatch: DispatchRepairWorkerFn = vi.fn();

    // Write manifest with only follow-up packets (no repair-worker routing).
    const followUpPacket = makeRepairable({
      packetId: "pkt-fu-r1-001",
      routingTarget: "follow-up",
      medic: false,
    });
    const manifestDir = path.join(tmpDir, ".polaris", "clusters", "POL-TEST", "qc", "repair-rounds", "1");
    mkdirSync(manifestDir, { recursive: true });
    const manifestPath = path.join(manifestDir, "repair-packets.json");
    const manifest = makeManifest([followUpPacket]);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    // QC result with only follow-up routingDecision findings (not repair-worker).
    const qcResult = makeResult({
      qcRunId: "qc-run-1",
      status: "findings",
      findings: [
        makeFinding({
          findingId: "f-fu",
          severity: "low",
          routingDecision: "follow-up",
          status: "open",
          attribution: { confidence: "low", reason: "unattributed" },
        }),
      ],
    });

    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [qcResult],
      dispatchRepairWorker: dispatch,
      maxRounds: 2,
    });

    expect(result.outcome).toBe("no-repairable");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("exits with max-rounds when repairs never make QC pass", async () => {
    const config = makeQcConfig({ maxRepairRounds: 1 });

    // Mock the QC rerun to always return findings (never passes).
    const findingsOrchestratorResult: QcOrchestratorResult = {
      trigger: "completed-cluster",
      results: [makeResult({ status: "findings", findings: [makeFinding({ routingDecision: "repair-worker" })] })],
      action: "block",
      summary: "findings persist",
    };
    vi.mocked(runQcAtTrigger).mockResolvedValue(findingsOrchestratorResult);

    const dispatch: DispatchRepairWorkerFn = vi.fn().mockResolvedValue({
      packetId: "pkt-test-r1-001",
      status: "success",
    } as RepairWorkerResult);

    const packet = makeRepairable({ packetId: "pkt-test-r1-001" });
    const manifestDir = path.join(tmpDir, ".polaris", "clusters", "POL-TEST", "qc", "repair-rounds", "1");
    mkdirSync(manifestDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(manifestDir, "repair-packets.json"),
      JSON.stringify(makeManifest([packet]), null, 2),
      "utf-8",
    );

    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [makeQcResultWithFindings()],
      dispatchRepairWorker: dispatch,
      maxRounds: 1,
    });

    expect(result.outcome).toBe("max-rounds");
    expect(result.rounds_completed).toBe(1);
  });

  it("exits with all-providers-failed when initial QC results all failed", async () => {
    const config = makeQcConfig();
    const dispatch: DispatchRepairWorkerFn = vi.fn();

    const failedResult = makeResult({ status: "failed", allProvidersFailed: true, findings: [] });

    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [failedResult],
      dispatchRepairWorker: dispatch,
      maxRounds: 2,
    });

    expect(result.outcome).toBe("all-providers-failed");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("exits with medic-referral when a repair worker fails", async () => {
    const config = makeQcConfig();

    const dispatch: DispatchRepairWorkerFn = vi.fn().mockResolvedValue({
      packetId: "pkt-test-r1-001",
      status: "failure",
      errorMessage: "worker crashed",
    } as RepairWorkerResult);

    const packet = makeRepairable({ packetId: "pkt-test-r1-001" });
    const manifestDir = path.join(tmpDir, ".polaris", "clusters", "POL-TEST", "qc", "repair-rounds", "1");
    mkdirSync(manifestDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(manifestDir, "repair-packets.json"),
      JSON.stringify(makeManifest([packet]), null, 2),
      "utf-8",
    );

    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [makeQcResultWithFindings()],
      dispatchRepairWorker: dispatch,
      maxRounds: 2,
    });

    expect(result.outcome).toBe("medic-referral");
    expect(result.loop_state.terminal_outcome).toBe("medic-referral");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("exits with operator-review when findings require human review", async () => {
    const config = makeQcConfig();
    const dispatch: DispatchRepairWorkerFn = vi.fn();

    const operatorReviewResult = makeResult({
      status: "findings",
      findings: [
        makeFinding({
          findingId: "f-op",
          severity: "high",
          routingDecision: "operator-review",
          status: "open",
          attribution: { confidence: "high", reason: "changed-file-owner" },
        }),
      ],
    });

    const result = await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [operatorReviewResult],
      dispatchRepairWorker: dispatch,
      maxRounds: 2,
    });

    expect(result.outcome).toBe("operator-review");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("calls onStateUpdate on each mutation", async () => {
    const config = makeQcConfig({ maxRepairRounds: 1 });
    const stateUpdates: string[] = [];

    // Mock the QC rerun to always return findings (max-rounds outcome).
    const findingsOrchestratorResult: QcOrchestratorResult = {
      trigger: "completed-cluster",
      results: [makeResult({ status: "findings", findings: [makeFinding({ routingDecision: "repair-worker" })] })],
      action: "block",
      summary: "findings persist",
    };
    vi.mocked(runQcAtTrigger).mockResolvedValue(findingsOrchestratorResult);

    const dispatch: DispatchRepairWorkerFn = vi.fn().mockResolvedValue({
      packetId: "pkt-test-r1-001",
      status: "success",
    } as RepairWorkerResult);

    const packet = makeRepairable({ packetId: "pkt-test-r1-001" });
    const manifestDir = path.join(tmpDir, ".polaris", "clusters", "POL-TEST", "qc", "repair-rounds", "1");
    mkdirSync(manifestDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(manifestDir, "repair-packets.json"),
      JSON.stringify(makeManifest([packet]), null, 2),
      "utf-8",
    );

    await runQcRepairLoop({
      clusterId: "POL-TEST",
      runId: "run-1",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [makeQcResultWithFindings()],
      dispatchRepairWorker: dispatch,
      maxRounds: 1,
      onStateUpdate: (s) => stateUpdates.push(s.terminal_outcome ?? "in-flight"),
    });

    // Should have received multiple state updates.
    expect(stateUpdates.length).toBeGreaterThan(0);
    // Final update should record terminal outcome.
    expect(stateUpdates[stateUpdates.length - 1]).toBe("max-rounds");
  });
});

describe("partitionRepairPackets", () => {
  it("puts non-conflicting packets in the same parallel group", () => {
    const p1 = makeRepairable({ packetId: "p1", parallelGroup: "g-000", allowedScope: ["src/a.ts"] });
    const p2 = makeRepairable({ packetId: "p2", parallelGroup: "g-000", allowedScope: ["src/b.ts"] });
    const { parallelGroups, serialized } = partitionRepairPackets([p1, p2]);
    expect(serialized).toHaveLength(0);
    // Both end up in at least one group.
    const allPackets = parallelGroups.flat();
    expect(allPackets).toHaveLength(2);
  });

  it("puts medic packets in serialized queue", () => {
    const medicPkt = makeRepairable({ packetId: "p-medic", medic: true, routingTarget: "operator-review" });
    const normalPkt = makeRepairable({ packetId: "p-normal" });
    const { parallelGroups, serialized } = partitionRepairPackets([medicPkt, normalPkt]);
    expect(serialized).toContainEqual(expect.objectContaining({ packetId: "p-medic" }));
    expect(parallelGroups.flat()).toContainEqual(expect.objectContaining({ packetId: "p-normal" }));
  });

  it("puts operator-review packets in serialized queue", () => {
    const opPkt = makeRepairable({ packetId: "p-op", routingTarget: "operator-review", medic: false });
    const { serialized } = partitionRepairPackets([opPkt]);
    expect(serialized).toContainEqual(expect.objectContaining({ packetId: "p-op" }));
  });
});

describe("initRepairLoopState", () => {
  it("returns a zero-indexed loop state", () => {
    const state = initRepairLoopState({ maxRounds: 3, sourceQcRunIds: ["qc-1", "qc-2"] });
    expect(state.current_round).toBe(0);
    expect(state.max_rounds).toBe(3);
    expect(state.source_qc_run_ids).toEqual(["qc-1", "qc-2"]);
    expect(state.terminal_outcome).toBeNull();
    expect(state.pending_packet_ids).toEqual([]);
    expect(state.completed_packet_ids).toEqual([]);
  });
});

function writeClusterState(dir: string, clusterId: string): void {
  const clusterStateDir = path.join(dir, ".polaris", "clusters", clusterId);
  mkdirSync(clusterStateDir, { recursive: true });
  const { writeFileSync } = require("node:fs");
  writeFileSync(
    path.join(clusterStateDir, "cluster-state.json"),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
    "utf-8",
  );
}

describe("repair loop cluster-state durability", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `polaris-repair-loop-durability-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    vi.mocked(runQcAtTrigger).mockReset();
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures.
    }
  });

  it("records the terminal outcome and manifest path in cluster state", async () => {
    const clusterId = "POL-DURABLE";
    writeClusterState(tmpDir, clusterId);

    const config = makeQcConfig({ maxRepairRounds: 2 });
    vi.mocked(runQcAtTrigger).mockResolvedValue(makePassedQcResult());

    const packet = makeRepairable({ packetId: "pkt-durable-r1-001" });
    const manifestDir = path.join(tmpDir, ".polaris", "clusters", clusterId, "qc", "repair-rounds", "1");
    mkdirSync(manifestDir, { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      path.join(manifestDir, "repair-packets.json"),
      JSON.stringify(makeManifest([packet]), null, 2),
      "utf-8",
    );

    const dispatch: DispatchRepairWorkerFn = vi.fn().mockResolvedValue({
      packetId: "pkt-durable-r1-001",
      status: "success",
    } as RepairWorkerResult);

    const result = await runQcRepairLoop({
      clusterId,
      runId: "run-durable",
      branch: "main",
      repoRoot: tmpDir,
      telemetryFile: path.join(tmpDir, "telemetry.jsonl"),
      config,
      registry: emptyRegistry,
      initialQcResults: [makeQcResultWithFindings()],
      dispatchRepairWorker: dispatch,
      maxRounds: 2,
    });

    expect(result.outcome).toBe("pass");

    const clusterState = readClusterStateSync(clusterId, tmpDir);
    expect(clusterState).not.toBeNull();
    expect(clusterState?.qc_repair_outcome).toBe("pass");
    expect(clusterState?.qc_repair_manifests?.[1]).toContain(
      path.join("qc", "repair-rounds", "1", "repair-packets.json"),
    );
  });
});
