/**
 * Orphan detection and child recovery workflow.
 *
 * Detects workers that have gone silent, failed to acknowledge, or left
 * partial execution traces. Implements the 5-scenario recovery model:
 *
 *   A: no-worker-assignment  — packet written, no worker_id after launch_timeout
 *   B: no-acknowledgment     — worker_id present, no ack within launch_to_first_heartbeat_ms
 *   C: no-heartbeat          — acknowledged, heartbeat > orphan_timeout_ms ago, no result
 *   D: missing-result-artifact — worker-result event received but expected_result_path invalid
 *   E: stale-dispatch        — dispatched_at + stale_dispatch_timeout ago, still handoff-pending
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readState,
  writeStateAtomic,
  type LoopState,
  type WorkerRuntimeState,
} from "./checkpoint.js";

// ── Telemetry helpers ─────────────────────────────────────────────────────────

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

function resolveTelemetryFile(state: LoopState, repoRoot: string): string {
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  return join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
}

/** Returns true only when path is a non-empty string and the file exists. */
function safeResultExists(path: unknown): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

// ── Recovery scenario types ───────────────────────────────────────────────────

export type RecoveryReason =
  | "no-worker-assignment"
  | "no-acknowledgment"
  | "no-heartbeat"
  | "missing-result-artifact-no-commits"
  | "missing-result-artifact-commits-found"
  | "stale-dispatch";

export interface RecoveryDetection {
  childId: string;
  dispatchId: string;
  reason: RecoveryReason;
  requiresApproval: boolean;
}

export interface OrphanCheckResult {
  detected: RecoveryDetection[];
  checked: number;
}

// ── Timeout defaults ──────────────────────────────────────────────────────────

export interface OrphanTimeoutConfig {
  /** Max ms from dispatch before worker_id expected (Scenario A) */
  launchTimeoutMs: number;
  /** Max ms from dispatch before acknowledgment expected (Scenario B) */
  launchToFirstHeartbeatMs: number;
  /** Max ms since last heartbeat before orphan declared (Scenario C) */
  orphanTimeoutMs: number;
  /** Max ms since dispatched_at with no state change (Scenario E) */
  staleDispatchTimeoutMs: number;
}

const DEFAULT_ORPHAN_TIMEOUTS: OrphanTimeoutConfig = {
  launchTimeoutMs: 30_000,
  launchToFirstHeartbeatMs: 30_000,
  orphanTimeoutMs: 300_000,       // 5 min (was 10 min)
  staleDispatchTimeoutMs: 1_800_000, // 30 min
};

// ── Telemetry scanning ────────────────────────────────────────────────────────

function hasTelemetryEvent(telemetryFile: string, eventName: string, childId: string): boolean {
  if (!existsSync(telemetryFile)) return false;
  try {
    const lines = readFileSync(telemetryFile, "utf-8").trim().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as { event?: string; child_id?: string };
        if (e.event === eventName && e.child_id === childId) return true;
      } catch { continue; }
    }
  } catch { /* ignore */ }
  return false;
}

// ── Emit recovery telemetry events ───────────────────────────────────────────

function emitRecoveryInitiated(
  telemetryFile: string,
  childId: string,
  dispatchId: string,
  reason: RecoveryReason,
): void {
  appendTelemetry(telemetryFile, {
    event: "child-recovery-initiated",
    event_id: randomUUID(),
    child_id: childId,
    dispatch_id: dispatchId,
    recovery_reason: reason,
    detected_at: new Date().toISOString(),
  });
}

function emitChildOrphaned(
  telemetryFile: string,
  childId: string,
  dispatchId: string,
  lastHeartbeatAt: string | null,
): void {
  appendTelemetry(telemetryFile, {
    event: "child-orphaned",
    event_id: randomUUID(),
    child_id: childId,
    dispatch_id: dispatchId,
    last_heartbeat_at: lastHeartbeatAt,
    orphaned_at: new Date().toISOString(),
  });
}

function emitRecoveryApprovalRequested(
  telemetryFile: string,
  childId: string,
  dispatchId: string,
  reason: RecoveryReason,
): void {
  appendTelemetry(telemetryFile, {
    event: "recovery-approval-requested",
    event_id: randomUUID(),
    child_id: childId,
    dispatch_id: dispatchId,
    recovery_reason: reason,
    operator_notified_at: new Date().toISOString(),
  });
}

export function emitRecoveryApproved(
  telemetryFile: string,
  childId: string,
  dispatchId: string,
  approvedBy: string,
): void {
  appendTelemetry(telemetryFile, {
    event: "recovery-approved",
    event_id: randomUUID(),
    child_id: childId,
    dispatch_id: dispatchId,
    approved_by: approvedBy,
    approved_at: new Date().toISOString(),
  });
}

function emitChildRequeued(
  telemetryFile: string,
  childId: string,
  newDispatchId: string,
  previousDispatchId: string,
): void {
  appendTelemetry(telemetryFile, {
    event: "child-requeued",
    event_id: randomUUID(),
    child_id: childId,
    new_dispatch_id: newDispatchId,
    previous_dispatch_id: previousDispatchId,
    requeued_at: new Date().toISOString(),
  });
}

// ── State mutation for recovery ───────────────────────────────────────────────

function transitionToOrphaned(
  stateFile: string,
  state: LoopState,
  childId: string,
): void {
  const childMeta = state.open_children_meta?.[childId];
  if (!childMeta?.dispatch_record) return;

  const updatedMeta = {
    ...state.open_children_meta,
    [childId]: {
      ...childMeta,
      dispatch_record: {
        ...childMeta.dispatch_record,
        runtime_state: "orphaned" as WorkerRuntimeState,
      },
    },
  };
  writeStateAtomic(stateFile, { ...state, open_children_meta: updatedMeta });
}

/**
 * Reset a dispatch record for safe auto-redispatch.
 * Preserves the old dispatch_id in the requeue event for audit.
 */
function resetForRedispatch(
  stateFile: string,
  state: LoopState,
  childId: string,
): string {
  const childMeta = state.open_children_meta?.[childId];
  if (!childMeta?.dispatch_record) return randomUUID();

  const newDispatchId = randomUUID();

  // Clear dispatch record but retain audit trail via telemetry
  const updatedMeta = {
    ...state.open_children_meta,
    [childId]: {
      ...childMeta,
      dispatch_record: undefined,
    },
  };

  // Reset active_child so a new dispatch can proceed
  writeStateAtomic(stateFile, {
    ...state,
    active_child: "",
    open_children_meta: updatedMeta as typeof state.open_children_meta,
  });

  return newDispatchId;
}

// ── Main detection and recovery workflow ──────────────────────────────────────

export interface OrphanCheckOptions {
  stateFile: string;
  repoRoot: string;
  timeouts?: Partial<OrphanTimeoutConfig>;
}

/**
 * Check the current state for orphaned children across all 5 scenarios.
 * Emits telemetry events for detected cases.
 * Auto-requeues for safe scenarios (A, B, C, E).
 * Emits recovery-approval-requested and halts for approval scenario (D).
 */
export function checkOrphans(options: OrphanCheckOptions): OrphanCheckResult {
  const timeouts: OrphanTimeoutConfig = {
    ...DEFAULT_ORPHAN_TIMEOUTS,
    ...options.timeouts,
  };

  let state: LoopState;
  try {
    state = readState(options.stateFile);
  } catch {
    return { detected: [], checked: 0 };
  }

  const telemetryFile = resolveTelemetryFile(state, options.repoRoot);
  const now = Date.now();
  const detected: RecoveryDetection[] = [];
  let checked = 0;

  // Check the active child (if any)
  if (state.active_child) {
    checked++;
    const childMeta = state.open_children_meta?.[state.active_child];
    const dr = childMeta?.dispatch_record;

    if (dr && dr.runtime_state !== "completed" && dr.runtime_state !== "failed") {
      const dispatchedAt = new Date(dr.dispatched_at).getTime();
      const elapsed = now - dispatchedAt;

      // Scenario A: packet written, no worker_id after launch_timeout
      if (!dr.worker_id && elapsed > timeouts.launchTimeoutMs) {
        const detection: RecoveryDetection = {
          childId: state.active_child,
          dispatchId: dr.dispatch_id,
          reason: "no-worker-assignment",
          requiresApproval: false,
        };
        detected.push(detection);
        emitRecoveryInitiated(telemetryFile, state.active_child, dr.dispatch_id, "no-worker-assignment");
        emitChildOrphaned(telemetryFile, state.active_child, dr.dispatch_id, null);
        const newId = resetForRedispatch(options.stateFile, state, state.active_child);
        emitChildRequeued(telemetryFile, state.active_child, newId, dr.dispatch_id);
        return { detected, checked };
      }

      // Scenario B: worker_id present, no acknowledgment within launch timeout
      if (dr.worker_id && !dr.first_heartbeat_at && elapsed > timeouts.launchToFirstHeartbeatMs) {
        const detection: RecoveryDetection = {
          childId: state.active_child,
          dispatchId: dr.dispatch_id,
          reason: "no-acknowledgment",
          requiresApproval: false,
        };
        detected.push(detection);
        emitRecoveryInitiated(telemetryFile, state.active_child, dr.dispatch_id, "no-acknowledgment");
        emitChildOrphaned(telemetryFile, state.active_child, dr.dispatch_id, null);
        const newId = resetForRedispatch(options.stateFile, state, state.active_child);
        emitChildRequeued(telemetryFile, state.active_child, newId, dr.dispatch_id);
        return { detected, checked };
      }

      // Scenario C: acknowledged, heartbeat lost, no result — auto-replace
      if (dr.first_heartbeat_at && !safeResultExists(dr.expected_result_path)) {
        const lastHb = dr.last_heartbeat_at ?? dr.first_heartbeat_at;
        const heartbeatAge = now - new Date(lastHb).getTime();
        if (heartbeatAge > timeouts.orphanTimeoutMs) {
          const detection: RecoveryDetection = {
            childId: state.active_child,
            dispatchId: dr.dispatch_id,
            reason: "no-heartbeat",
            requiresApproval: false,
          };
          detected.push(detection);
          emitRecoveryInitiated(telemetryFile, state.active_child, dr.dispatch_id, "no-heartbeat");
          emitChildOrphaned(telemetryFile, state.active_child, dr.dispatch_id, lastHb);
          const newId = resetForRedispatch(options.stateFile, state, state.active_child);
          emitChildRequeued(telemetryFile, state.active_child, newId, dr.dispatch_id);
          return { detected, checked };
        }
      }

      // Scenario D: worker-result event received but result artifact missing or invalid
      const hasWorkerResult = hasTelemetryEvent(telemetryFile, "worker-result", state.active_child);
      if (hasWorkerResult && !safeResultExists(dr.expected_result_path)) {
        // Check for commits in child scope (simplified: assume no commits for now)
        const reason = "missing-result-artifact-no-commits" as RecoveryReason;
        const detection: RecoveryDetection = {
          childId: state.active_child,
          dispatchId: dr.dispatch_id,
          reason,
          requiresApproval: true,
        };
        detected.push(detection);
        emitRecoveryInitiated(telemetryFile, state.active_child, dr.dispatch_id, reason);
        emitChildOrphaned(telemetryFile, state.active_child, dr.dispatch_id, dr.last_heartbeat_at ?? null);
        emitRecoveryApprovalRequested(telemetryFile, state.active_child, dr.dispatch_id, reason);
        transitionToOrphaned(options.stateFile, state, state.active_child);
        return { detected, checked };
      }

      // Scenario E: stale dispatch — dispatched_at + stale_dispatch_timeout with no state change
      if (
        (dr.runtime_state === "packet-created" || dr.runtime_state === "delegated") &&
        elapsed > timeouts.staleDispatchTimeoutMs
      ) {
        const detection: RecoveryDetection = {
          childId: state.active_child,
          dispatchId: dr.dispatch_id,
          reason: "stale-dispatch",
          requiresApproval: false,
        };
        detected.push(detection);
        emitRecoveryInitiated(telemetryFile, state.active_child, dr.dispatch_id, "stale-dispatch");
        emitChildOrphaned(telemetryFile, state.active_child, dr.dispatch_id, null);
        const newId = resetForRedispatch(options.stateFile, state, state.active_child);
        emitChildRequeued(telemetryFile, state.active_child, newId, dr.dispatch_id);
        return { detected, checked };
      }
    }
  }

  return { detected, checked };
}
