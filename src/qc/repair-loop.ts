/**
 * QC repair loop orchestration.
 *
 * The Foreman calls `runQcRepairLoop` after a completed-cluster QC run produces
 * findings. This module:
 *
 *   1. Discovers a compiled repair packet manifest for the current round.
 *   2. Converts eligible repair packets into Foreman-dispatched repair workers.
 *   3. Awaits repair worker completion (via sealed result files / adapter).
 *   4. Reruns QC after all repair workers in a round have completed.
 *   5. Loops until: pass, no repairable packets, max rounds reached,
 *      all providers failed, operator review required, or Medic referral.
 *
 * Dispatch boundary: the parent/orchestrator NEVER implements repair code.
 * Each repair packet becomes a sealed WorkerPacket with worker_role: "repair".
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { QcConfig } from "../config/schema.js";
import type {
  QcRepairPacket,
  QcRepairPacketManifest,
  QcResolutionArtifact,
  QcResult,
} from "./types.js";
import {
  compileAndWriteRepairPackets,
  readRepairPacketManifest,
  getRepairRoundDir,
} from "./repair-packets.js";
import { QC_RESOLUTION_OUTCOMES } from "./types.js";
import type { RunQcAtTriggerOptions, QcOrchestratorResult } from "./orchestration.js";
import { runQcAtTrigger } from "./orchestration.js";
import type { QcProviderRegistry } from "./provider.js";
import type { QcRepairLoopState, QcRepairLoopOutcome } from "../loop/checkpoint.js";
import { writeClusterState, readClusterStateSync } from "../cluster-state/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Default maximum repair rounds when not configured. */
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;

/** Default timeout for a single repair worker dispatch (30 minutes). */
export const DEFAULT_REPAIR_DISPATCH_TIMEOUT_MS = 1_800_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Dispatch result for a single repair worker. */
export interface RepairWorkerResult {
  packetId: string;
  status: "success" | "failure" | "skipped";
  commitSha?: string;
  errorMessage?: string;
}

/** Caller-supplied function to dispatch a single repair packet as a worker. */
export type DispatchRepairWorkerFn = (
  packet: QcRepairPacket,
  round: number,
  manifest: QcRepairPacketManifest,
  signal?: AbortSignal,
) => Promise<RepairWorkerResult>;

/** Options for running the bounded QC repair loop. */
export interface RunQcRepairLoopOptions {
  /** Cluster ID for this run. */
  clusterId: string;
  /** Polaris run ID. */
  runId: string;
  /** Git branch. */
  branch: string;
  /** Absolute repo root path. */
  repoRoot: string;
  /** Telemetry JSONL file path. */
  telemetryFile: string;
  /** QC config from polaris.config.json. */
  config: QcConfig;
  /** Registered QC providers. */
  registry: QcProviderRegistry;
  /** QC results that triggered this repair cycle (from completed-cluster run). */
  initialQcResults: QcResult[];
  /** Caller-supplied repair worker dispatcher. The Foreman wraps this around its dispatch adapter. */
  dispatchRepairWorker: DispatchRepairWorkerFn;
  /** Validation commands to embed in repair packets. */
  validationCommands?: string[];
  /** QC runner timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum repair rounds. Defaults to `DEFAULT_MAX_REPAIR_ROUNDS`. */
  maxRounds?: number;
  /** Current loop state's qc_repair_loop — resume from prior round when present. */
  priorLoopState?: QcRepairLoopState | null;
  /** Optional callback when loop state is mutated (for checkpoint persistence). */
  onStateUpdate?: (state: QcRepairLoopState) => void;
}

/** Result of the QC repair loop. */
export interface QcRepairLoopResult {
  outcome: Exclude<QcRepairLoopOutcome, null>;
  rounds_completed: number;
  final_qc_results: QcResult[];
  loop_state: QcRepairLoopState;
  summary: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function appendTelemetry(
  telemetryFile: string,
  event: Record<string, unknown>,
): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

/**
 * Emit a pre-dispatch telemetry checkpoint and wrap the dispatch call in a
 * configurable timeout. A timed-out dispatch resolves to a failure/timeout
 * RepairWorkerResult instead of blocking the loop indefinitely.
 * On timeout, aborts the dispatch via AbortSignal to terminate the worker process.
 */
async function dispatchRepairWorkerWithTimeout(
  dispatch: DispatchRepairWorkerFn,
  packet: QcRepairPacket,
  round: number,
  manifest: QcRepairPacketManifest,
  timeoutMs: number,
  telemetryFile: string,
  runId: string,
  clusterId: string,
): Promise<RepairWorkerResult> {
  appendTelemetry(telemetryFile, {
    event: "qc-repair-worker-dispatch-start",
    run_id: runId,
    cluster_id: clusterId,
    round,
    packet_id: packet.packetId,
    medic: packet.medic,
    parallel_group: packet.parallelGroup,
    timestamp: new Date().toISOString(),
  });

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race<RepairWorkerResult>([
      dispatch(packet, round, manifest, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`Repair worker dispatch timed out after ${timeoutMs}ms`));
          reject(new Error(`Repair worker dispatch timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return result;
  } catch (err) {
    if (timer) clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    if (timedOut) {
      appendTelemetry(telemetryFile, {
        event: "qc-repair-worker-dispatch-timeout",
        run_id: runId,
        cluster_id: clusterId,
        round,
        packet_id: packet.packetId,
        timeout_ms: timeoutMs,
        error: msg,
        timestamp: new Date().toISOString(),
      });
    }
    return {
      packetId: packet.packetId,
      status: "failure",
      errorMessage: msg,
    };
  }
}

async function persistQcRepairOutcome(
  clusterId: string,
  repoRoot: string,
  outcome: Exclude<QcRepairLoopOutcome, null>,
): Promise<void> {
  try {
    const clusterState = readClusterStateSync(clusterId, repoRoot);
    if (!clusterState) return;
    await writeClusterState(
      clusterId,
      {
        ...clusterState,
        state_generation: clusterState.state_generation + 1,
        qc_repair_outcome: outcome,
      },
      repoRoot,
    );
  } catch {
    // Best-effort: the loop outcome is already returned to the caller and
    // recorded in the loop checkpoint. Do not block finalization on a
    // cluster-state write race.
  }
}

async function persistQcRepairManifest(
  clusterId: string,
  repoRoot: string,
  round: number,
  manifestPath: string,
): Promise<void> {
  try {
    const clusterState = readClusterStateSync(clusterId, repoRoot);
    if (!clusterState) return;
    const manifests = { ...(clusterState.qc_repair_manifests ?? {}), [round]: manifestPath };
    if (
      clusterState.qc_repair_manifests &&
      clusterState.qc_repair_manifests[round] === manifestPath
    ) {
      return;
    }
    await writeClusterState(
      clusterId,
      {
        ...clusterState,
        state_generation: clusterState.state_generation + 1,
        qc_repair_manifests: manifests,
      },
      repoRoot,
    );
  } catch {
    // Best-effort durability for repair-round manifest pointer.
  }
}

/** Returns true when any finding in the results routes to repair-worker. */
function hasRepairableFindings(results: QcResult[]): boolean {
  return results.some((r) =>
    r.findings.some(
      (f) =>
        (f.routingDecision === "repair-worker" || f.routingDecision === "original-worker") &&
        f.status !== "waived" &&
        f.status !== "autofixed" &&
        f.status !== "repaired",
    ),
  );
}

/** Returns true when all QC providers failed in every result. */
function allProvidersFailed(results: QcResult[]): boolean {
  return (
    results.length > 0 &&
    results.every((r) => r.allProvidersFailed || r.status === "failed")
  );
}

/** Returns true when any finding requires operator review. */
function requiresOperatorReview(results: QcResult[]): boolean {
  return results.some((r) =>
    r.findings.some(
      (f) =>
        f.routingDecision === "operator-review" &&
        f.status !== "waived" &&
        f.status !== "repaired",
    ),
  );
}

/** Returns true when the QC rerun passed (no open/blocking findings). */
function rerunPassed(results: QcResult[]): boolean {
  if (results.length === 0) return false;
  return results.every((r) => r.status === "passed" || r.status === "skipped");
}

/** Partition packets into safe-to-parallel and must-serialize groups. */
export function partitionRepairPackets(packets: QcRepairPacket[]): {
  parallelGroups: QcRepairPacket[][];
  serialized: QcRepairPacket[];
} {
  // Medic packets are always serialized; operator-review packets are never dispatched.
  const serialized = packets.filter((p) => p.medic);
  const parallelizable = packets.filter(
    (p) => !p.medic && p.routingTarget !== "operator-review",
  );

  // Group by parallelGroup assignment from the compiler.
  const groups = new Map<string, QcRepairPacket[]>();
  for (const pkt of parallelizable) {
    const key = pkt.parallelGroup ?? `solo-${pkt.packetId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(pkt);
  }

  return {
    parallelGroups: Array.from(groups.values()),
    serialized,
  };
}

/** Initialize a fresh QcRepairLoopState. */
export function initRepairLoopState(opts: {
  maxRounds: number;
  sourceQcRunIds: string[];
}): QcRepairLoopState {
  const now = new Date().toISOString();
  return {
    current_round: 0,
    max_rounds: opts.maxRounds,
    source_qc_run_ids: opts.sourceQcRunIds,
    manifest_path: null,
    pending_packet_ids: [],
    completed_packet_ids: [],
    rerun_requested: false,
    rerun_qc_run_ids: {},
    terminal_outcome: null,
    initiated_at: now,
    updated_at: now,
  };
}

// ── Operator resolution artifact helpers ──────────────────────────────────────

/** Path for the operator-written resolution artifact for a repair round. */
export function getQcResolutionArtifactPath(
  clusterId: string,
  round: number,
  repoRoot?: string,
): string {
  return join(getRepairRoundDir(clusterId, round, repoRoot), "resolution.json");
}

/** Resolve the finding IDs covered by a resolution artifact. */
export function resolveQcResolutionFindings(
  manifest: QcRepairPacketManifest,
  explicitFindings?: string[],
): string[] {
  const manifestFindings = [
    ...new Set(manifest.packets.flatMap((p) => p.findingIds)),
  ].sort();

  if (!explicitFindings || explicitFindings.length === 0) {
    return manifestFindings;
  }

  const allowed = new Set(manifestFindings);
  const unknown = explicitFindings.filter((id) => !allowed.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown finding IDs: ${unknown.join(", ")}. Expected one of: ${manifestFindings.join(", ") || "none"}`,
    );
  }

  return [...new Set(explicitFindings)].sort();
}

/** Determine the resolver identity from git config or the default operator. */
export function getResolverIdentity(repoRoot?: string): string {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      cwd: repoRoot || process.cwd(),
      encoding: "utf-8",
    }).trim();
    return name || "lsctech";
  } catch {
    return "lsctech";
  }
}

const QC_RESOLUTION_OUTCOME_SET = new Set<string>(QC_RESOLUTION_OUTCOMES);

/** Validate a resolution artifact object. */
export function isValidQcResolutionArtifact(
  value: unknown,
): value is QcResolutionArtifact {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (typeof v.schemaVersion !== "string") return false;
  if (typeof v.clusterId !== "string") return false;
  if (typeof v.round !== "number") return false;
  if (typeof v.resolvedAt !== "string") return false;
  if (typeof v.resolver !== "string" || v.resolver === "") return false;
  if (
    typeof v.resolvedOutcome !== "string" ||
    !QC_RESOLUTION_OUTCOME_SET.has(v.resolvedOutcome)
  ) {
    return false;
  }
  if (typeof v.reason !== "string" || v.reason.trim() === "") return false;
  if (
    !Array.isArray(v.findings) ||
    v.findings.length === 0 ||
    !v.findings.every((f) => typeof f === "string")
  ) {
    return false;
  }

  return true;
}

/** Read and validate a resolution artifact, if it exists. */
export function readQcResolutionArtifact(
  clusterId: string,
  round: number,
  repoRoot?: string,
): QcResolutionArtifact | null {
  const artifactPath = getQcResolutionArtifactPath(clusterId, round, repoRoot);
  try {
    const data = readFileSync(artifactPath, "utf-8");
    const parsed = JSON.parse(data) as unknown;
    if (isValidQcResolutionArtifact(parsed)) {
      return parsed;
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

/** Write a resolution artifact atomically and return its absolute path. */
export function writeQcResolutionArtifact(options: {
  clusterId: string;
  round: number;
  resolver: string;
  resolvedOutcome: "pass" | "no-repairable";
  reason: string;
  findings: string[];
  repoRoot?: string;
}): string {
  const {
    clusterId,
    round,
    resolver,
    resolvedOutcome,
    reason,
    findings,
    repoRoot,
  } = options;

  const artifactPath = getQcResolutionArtifactPath(clusterId, round, repoRoot);
  const dir = dirname(artifactPath);
  mkdirSync(dir, { recursive: true });

  const artifact: QcResolutionArtifact = {
    schemaVersion: "1.0",
    clusterId,
    round,
    resolvedAt: new Date().toISOString(),
    resolver,
    resolvedOutcome,
    reason,
    findings,
  };

  const tempPath = `${artifactPath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  try {
    writeFileSync(tempPath, JSON.stringify(artifact, null, 2), "utf-8");
    renameSync(tempPath, artifactPath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup failure.
    }
    throw error;
  }

  return artifactPath;
}

// ── Main repair loop ───────────────────────────────────────────────────────────

/**
 * Run the bounded QC repair loop.
 *
 * The loop is Foreman-owned: it coordinates dispatch, never implements repairs.
 * Returns deterministically on pass, no-repairable, max-rounds, all-providers-failed,
 * operator-review, or medic-referral.
 */
export async function runQcRepairLoop(
  options: RunQcRepairLoopOptions,
): Promise<QcRepairLoopResult> {
  const {
    clusterId,
    runId,
    branch,
    repoRoot,
    telemetryFile,
    config,
    registry,
    initialQcResults,
    dispatchRepairWorker,
    validationCommands = [],
    timeoutMs,
    maxRounds = DEFAULT_MAX_REPAIR_ROUNDS,
    priorLoopState,
    onStateUpdate,
  } = options;

  const repairDispatchTimeoutMs =
    config.repairDispatchTimeoutMs ?? DEFAULT_REPAIR_DISPATCH_TIMEOUT_MS;

  if (!config.enabled) {
    const state = initRepairLoopState({
      maxRounds,
      sourceQcRunIds: initialQcResults.map((r) => r.qcRunId),
    });
    state.terminal_outcome = "qc-disabled";
    state.updated_at = new Date().toISOString();
    await persistQcRepairOutcome(clusterId, repoRoot, "qc-disabled");
    return {
      outcome: "qc-disabled",
      rounds_completed: 0,
      final_qc_results: initialQcResults,
      loop_state: state,
      summary: "QC repair loop skipped — QC disabled by configuration",
    };
  }

  const sourceRunIds = initialQcResults.map((r) => r.qcRunId);
  let loopState: QcRepairLoopState = priorLoopState ?? initRepairLoopState({ maxRounds, sourceQcRunIds: sourceRunIds });

  let currentResults = initialQcResults;
  let roundsCompleted = loopState.current_round;

  appendTelemetry(telemetryFile, {
    event: "qc-repair-loop-started",
    run_id: runId,
    cluster_id: clusterId,
    max_rounds: maxRounds,
    source_qc_run_ids: sourceRunIds,
    timestamp: new Date().toISOString(),
  });

  // ── Main loop ──────────────────────────────────────────────────────────────

  while (roundsCompleted < maxRounds) {
    const round = roundsCompleted + 1;

    // Check exit conditions at the top of each round.
    if (rerunPassed(currentResults) && round > 1) {
      // A rerun already passed in this call frame — exit.
      break;
    }

    if (allProvidersFailed(currentResults)) {
      loopState = { ...loopState, terminal_outcome: "all-providers-failed", updated_at: new Date().toISOString() };
      onStateUpdate?.(loopState);
      appendTelemetry(telemetryFile, {
        event: "qc-repair-loop-terminal",
        run_id: runId,
        outcome: "all-providers-failed",
        round,
        timestamp: new Date().toISOString(),
      });
      await persistQcRepairOutcome(clusterId, repoRoot, "all-providers-failed");
      return {
        outcome: "all-providers-failed",
        rounds_completed: roundsCompleted,
        final_qc_results: currentResults,
        loop_state: loopState,
        summary: `QC repair loop halted: all QC providers failed at round ${round}`,
      };
    }

    // ── Compile / discover repair packets ──────────────────────────────────

    let manifest: QcRepairPacketManifest | null = null;

    // Try to read an existing manifest for this round first (idempotent re-entry).
    manifest = readRepairPacketManifest(clusterId, round, repoRoot);

    if (!manifest) {
      // Compile fresh repair packets from current QC results.
      const compiled = compileAndWriteRepairPackets({
        clusterId,
        round,
        qcResults: currentResults,
        config,
        validationCommands,
        repoRoot,
      });
      manifest = compiled.manifest;

      // Update cluster state with manifest path.
      await persistQcRepairManifest(clusterId, repoRoot, round, compiled.manifestPath);

      loopState = {
        ...loopState,
        current_round: round,
        manifest_path: compiled.manifestPath,
        pending_packet_ids: compiled.packets.map((p) => p.packetId),
        updated_at: new Date().toISOString(),
      };
      onStateUpdate?.(loopState);

      appendTelemetry(telemetryFile, {
        event: "qc-repair-manifest-compiled",
        run_id: runId,
        cluster_id: clusterId,
        round,
        packet_count: compiled.packets.length,
        manifest_path: compiled.manifestPath,
        timestamp: new Date().toISOString(),
      });
    } else {
      const existingManifestPath =
        loopState.manifest_path ??
        join(repoRoot, ".polaris", "clusters", clusterId, "qc", "repair-rounds", String(round), "repair-packets.json");
      loopState = {
        ...loopState,
        current_round: round,
        manifest_path: existingManifestPath,
        updated_at: new Date().toISOString(),
      };
      onStateUpdate?.(loopState);
      await persistQcRepairManifest(clusterId, repoRoot, round, existingManifestPath);
    }

    // ── Check for repairable packets ────────────────────────────────────────

    const dispatchablePackets = manifest.packets.filter(
      (p) =>
        p.routingTarget === "repair-worker" &&
        p.status === "pending" &&
        !loopState.completed_packet_ids.includes(p.packetId),
    );

    if (dispatchablePackets.length === 0 && requiresOperatorReview(currentResults)) {
      loopState = { ...loopState, terminal_outcome: "operator-review", updated_at: new Date().toISOString() };
      onStateUpdate?.(loopState);
      appendTelemetry(telemetryFile, {
        event: "qc-repair-loop-terminal",
        run_id: runId,
        outcome: "operator-review",
        round,
        timestamp: new Date().toISOString(),
      });
      await persistQcRepairOutcome(clusterId, repoRoot, "operator-review");
      return {
        outcome: "operator-review",
        rounds_completed: roundsCompleted,
        final_qc_results: currentResults,
        loop_state: loopState,
        summary: `QC repair loop halted: unresolved operator-review findings at round ${round}`,
      };
    }

    if (dispatchablePackets.length === 0 && !hasRepairableFindings(currentResults)) {
      loopState = { ...loopState, terminal_outcome: "no-repairable", updated_at: new Date().toISOString() };
      onStateUpdate?.(loopState);
      appendTelemetry(telemetryFile, {
        event: "qc-repair-loop-terminal",
        run_id: runId,
        outcome: "no-repairable",
        round,
        timestamp: new Date().toISOString(),
      });
      await persistQcRepairOutcome(clusterId, repoRoot, "no-repairable");
      return {
        outcome: "no-repairable",
        rounds_completed: roundsCompleted,
        final_qc_results: currentResults,
        loop_state: loopState,
        summary: `QC repair loop: no repairable packets at round ${round}`,
      };
    }

    // ── Dispatch repair workers (parallel groups, then serialized) ──────────

    const { parallelGroups, serialized } = partitionRepairPackets(dispatchablePackets);
    const allWorkerResults: RepairWorkerResult[] = [];
    let hasMedicReferral = false;

    // Dispatch parallel groups.
    for (const group of parallelGroups) {
      appendTelemetry(telemetryFile, {
        event: "qc-repair-worker-group-start",
        run_id: runId,
        round,
        parallel_group: group[0]?.parallelGroup ?? null,
        packet_ids: group.map((p) => p.packetId),
        timestamp: new Date().toISOString(),
      });

      // Within a group, packets are non-conflicting and can run concurrently.
      const groupResults = await Promise.all(
        group.map((pkt) =>
          dispatchRepairWorkerWithTimeout(
            dispatchRepairWorker,
            pkt,
            round,
            manifest!,
            repairDispatchTimeoutMs,
            telemetryFile,
            runId,
            clusterId,
          )
        ),
      );
      allWorkerResults.push(...groupResults);
    }

    // Dispatch serialized (medic) packets sequentially.
    for (const pkt of serialized) {
      const result = await dispatchRepairWorkerWithTimeout(
        dispatchRepairWorker,
        pkt,
        round,
        manifest!,
        repairDispatchTimeoutMs,
        telemetryFile,
        runId,
        clusterId,
      );
      allWorkerResults.push(result);
    }

    // Record completed packet IDs.
    const completedIds = allWorkerResults
      .filter((r) => r.status !== "skipped")
      .map((r) => r.packetId);
    loopState = {
      ...loopState,
      completed_packet_ids: [...loopState.completed_packet_ids, ...completedIds],
      pending_packet_ids: loopState.pending_packet_ids.filter((id) => !completedIds.includes(id)),
      updated_at: new Date().toISOString(),
    };
    onStateUpdate?.(loopState);

    // Check for failed repair workers → Medic referral.
    const failedWorkers = allWorkerResults.filter((r) => r.status === "failure");
    if (failedWorkers.length > 0) {
      hasMedicReferral = true;
      appendTelemetry(telemetryFile, {
        event: "qc-repair-worker-failures",
        run_id: runId,
        round,
        failed_packet_ids: failedWorkers.map((r) => r.packetId),
        errors: failedWorkers.map((r) => r.errorMessage ?? "unknown"),
        timestamp: new Date().toISOString(),
      });
    }

    if (hasMedicReferral) {
      loopState = { ...loopState, terminal_outcome: "medic-referral", updated_at: new Date().toISOString() };
      onStateUpdate?.(loopState);
      appendTelemetry(telemetryFile, {
        event: "qc-repair-loop-terminal",
        run_id: runId,
        outcome: "medic-referral",
        round,
        failed_count: failedWorkers.length,
        timestamp: new Date().toISOString(),
      });
      await persistQcRepairOutcome(clusterId, repoRoot, "medic-referral");
      return {
        outcome: "medic-referral",
        rounds_completed: roundsCompleted + 1,
        final_qc_results: currentResults,
        loop_state: loopState,
        summary: `QC repair loop: ${failedWorkers.length} repair worker(s) failed at round ${round} — Medic referral triggered`,
      };
    }

    roundsCompleted += 1;

    // ── QC rerun after successful repairs ───────────────────────────────────

    loopState = { ...loopState, rerun_requested: true, updated_at: new Date().toISOString() };
    onStateUpdate?.(loopState);

    appendTelemetry(telemetryFile, {
      event: "qc-repair-rerun-start",
      run_id: runId,
      cluster_id: clusterId,
      round,
      timestamp: new Date().toISOString(),
    });

    const rerunOptions: RunQcAtTriggerOptions = {
      config,
      registry,
      trigger: "completed-cluster",
      repoRoot,
      runId,
      clusterId,
      branch,
      telemetryFile,
      timeoutMs,
    };

    let rerunResult: QcOrchestratorResult;
    try {
      rerunResult = await runQcAtTrigger(rerunOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendTelemetry(telemetryFile, {
        event: "qc-repair-rerun-error",
        run_id: runId,
        round,
        error: msg,
        timestamp: new Date().toISOString(),
      });
      // Treat rerun error as all-providers-failed.
      loopState = { ...loopState, terminal_outcome: "all-providers-failed", updated_at: new Date().toISOString() };
      onStateUpdate?.(loopState);
      return {
        outcome: "all-providers-failed",
        rounds_completed: roundsCompleted,
        final_qc_results: currentResults,
        loop_state: loopState,
        summary: `QC repair loop: rerun at round ${round} threw an error: ${msg}`,
      };
    }

    // Record rerun QC run IDs.
    const rerunIds = rerunResult.results.map((r) => r.qcRunId).filter(Boolean);
    loopState = {
      ...loopState,
      rerun_requested: false,
      rerun_qc_run_ids: { ...loopState.rerun_qc_run_ids, [round]: rerunIds },
      updated_at: new Date().toISOString(),
    };
    onStateUpdate?.(loopState);

    appendTelemetry(telemetryFile, {
      event: "qc-repair-rerun-complete",
      run_id: runId,
      cluster_id: clusterId,
      round,
      action: rerunResult.action,
      summary: rerunResult.summary,
      rerun_qc_run_ids: rerunIds,
      timestamp: new Date().toISOString(),
    });

    currentResults = rerunResult.results;

    // Pass condition: rerun returned no blocking findings.
    if (rerunResult.action === "pass") {
      loopState = { ...loopState, terminal_outcome: "pass", updated_at: new Date().toISOString() };
      onStateUpdate?.(loopState);
      appendTelemetry(telemetryFile, {
        event: "qc-repair-loop-terminal",
        run_id: runId,
        outcome: "pass",
        round,
        timestamp: new Date().toISOString(),
      });
      await persistQcRepairOutcome(clusterId, repoRoot, "pass");
      return {
        outcome: "pass",
        rounds_completed: roundsCompleted,
        final_qc_results: currentResults,
        loop_state: loopState,
        summary: `QC repair loop passed after ${roundsCompleted} round(s)`,
      };
    }
  }

  // ── Max rounds exhausted ──────────────────────────────────────────────────

  if (requiresOperatorReview(currentResults)) {
    loopState = { ...loopState, terminal_outcome: "operator-review", updated_at: new Date().toISOString() };
    onStateUpdate?.(loopState);
    appendTelemetry(telemetryFile, {
      event: "qc-repair-loop-terminal",
      run_id: runId,
      outcome: "operator-review",
      rounds_completed: roundsCompleted,
      timestamp: new Date().toISOString(),
    });
    await persistQcRepairOutcome(clusterId, repoRoot, "operator-review");
    return {
      outcome: "operator-review",
      rounds_completed: roundsCompleted,
      final_qc_results: currentResults,
      loop_state: loopState,
      summary: `QC repair loop halted: unresolved operator-review findings after ${roundsCompleted} round(s)`,
    };
  }

  loopState = { ...loopState, terminal_outcome: "max-rounds", updated_at: new Date().toISOString() };
  onStateUpdate?.(loopState);
  appendTelemetry(telemetryFile, {
    event: "qc-repair-loop-terminal",
    run_id: runId,
    outcome: "max-rounds",
    rounds_completed: roundsCompleted,
    timestamp: new Date().toISOString(),
  });
  await persistQcRepairOutcome(clusterId, repoRoot, "max-rounds");
  return {
    outcome: "max-rounds",
    rounds_completed: roundsCompleted,
    final_qc_results: currentResults,
    loop_state: loopState,
    summary: `QC repair loop exhausted max rounds (${maxRounds}) without passing`,
  };
}
