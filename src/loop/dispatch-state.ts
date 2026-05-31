/**
 * Worker dispatch state machine types and transition logic.
 *
 * This module defines the runtime state machine for tracking worker execution
 * from packet creation through completion, failure, or orphaning.
 *
 * @module dispatch-state
 */

import type { ChildDispatchRecord } from "./checkpoint.js";

/**
 * Worker dispatch states.
 *
 * Represents the complete lifecycle of a dispatched worker.
 */
export type WorkerDispatchState =
  | "packet-created"    // Packet written, no worker associated
  | "delegated"         // Provider assigned, ready for handoff
  | "launching"         // Worker process spawn initiated
  | "acknowledged"      // Worker read packet and emitted worker-acknowledged, no heartbeat yet
  | "running"           // Worker acknowledged, first heartbeat received
  | "waiting-for-approval"  // Worker blocked on approval
  | "blocked"           // Worker stuck, no recent heartbeat
  | "completed"         // Worker finished successfully
  | "failed"            // Worker finished with error
  | "orphaned";         // Worker lost, no telemetry for timeout period

/**
 * Terminal states - once reached, no further transitions.
 */
export const TERMINAL_STATES: WorkerDispatchState[] = ["completed", "failed", "orphaned"];

/**
 * Active states - worker is still expected to produce telemetry.
 */
export const ACTIVE_STATES: WorkerDispatchState[] = [
  "launching",
  "acknowledged",
  "running",
  "waiting-for-approval",
  "blocked",
];

/**
 * Pre-launch states - worker has not yet started.
 */
export const PRE_LAUNCH_STATES: WorkerDispatchState[] = ["packet-created", "delegated"];

/**
 * Timeout configuration for worker lifecycle.
 */
export interface WorkerTimeoutConfig {
  /** Time after launching before first heartbeat expected (default: 30000ms) */
  launch_to_first_heartbeat_ms: number;

  /** Expected time between heartbeats during active work (default: 300000ms) */
  heartbeat_interval_ms: number;

  /** Time after last heartbeat before worker considered orphaned (default: 600000ms) */
  orphan_timeout_ms: number;

  /** Time waiting for approval before auto-fail (default: 3600000ms) */
  approval_timeout_ms: number;

  /** Time after acknowledgement before first heartbeat expected (default: 120000ms) */
  ack_to_first_heartbeat_ms: number;
}

/**
 * Default timeout values.
 */
export const DEFAULT_TIMEOUTS: WorkerTimeoutConfig = {
  launch_to_first_heartbeat_ms: 30000,   // 30 seconds
  heartbeat_interval_ms: 300000,         // 5 minutes
  orphan_timeout_ms: 600000,             // 10 minutes
  approval_timeout_ms: 3600000,          // 1 hour
  ack_to_first_heartbeat_ms: 120000,     // 2 minutes
};

/**
 * State history entry.
 */
export interface StateHistoryEntry {
  state: WorkerDispatchState;
  entered_at: string;  // ISO 8601 timestamp
  evidence?: string;   // Event ID, PID, or other evidence
}

/**
 * Enhanced dispatch record with state machine tracking.
 *
 * Note: This omits the original 'status' field from ChildDispatchRecord
 * and replaces it with the broader WorkerDispatchState.
 */
export interface EnhancedDispatchRecord extends Omit<ChildDispatchRecord, 'status'> {
  /** Provider name (now required) */
  provider: string;

  /** Adapter used for dispatch */
  adapter: string;

  /** Current dispatch state - extended from base */
  status: WorkerDispatchState;

  /** State transition history */
  state_history: StateHistoryEntry[];

  /** Last known heartbeat timestamp */
  last_heartbeat_at?: string;

  /** Last known step from heartbeat */
  last_heartbeat_step?: string;

  /** Process ID at launch (if applicable) */
  launch_pid?: number;

  /** Launch adapter used */
  launch_adapter?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry Event Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Base interface for all worker telemetry events.
 */
export interface WorkerTelemetryEventBase {
  event: string;
  event_id: string;
  dispatch_id: string;
  run_id: string;
  child_id: string;
  timestamp: string;  // ISO 8601
}

/**
 * Worker launch event - emitted when worker process starts.
 */
export interface WorkerLaunchEvent extends WorkerTelemetryEventBase {
  event: "worker-launch";
  provider: string;
  adapter: string;
  pid?: number;
}

/**
 * Worker heartbeat - periodic progress update.
 */
export interface WorkerHeartbeat extends WorkerTelemetryEventBase {
  event: "worker-heartbeat";
  step_cursor: string;
  step_detail?: string;
  progress_pct?: number;
  files_changed?: number;
  lines_added?: number;
  lines_deleted?: number;
  current_file?: string;
  tokens_used?: number;
  provider?: string;
  model?: string;
  elapsed_ms?: number;
}

/**
 * Worker blocked - waiting for approval.
 */
export interface WorkerBlockedEvent extends WorkerTelemetryEventBase {
  event: "worker-blocked";
  blocker_id: string;
  reason: "needs-approval" | "approval-timeout" | "error" | "unknown";
  approval_type: "destructive" | "cost" | "security" | "ambiguous" | "external";
  description: string;
  suggested_action?: string;
  affected_files?: string[];
  command_preview?: string;
  cost_estimate?: string;
  policy_id?: string;
  auto_approve_eligible?: boolean;
}

/**
 * Worker approved - approval granted.
 */
export interface WorkerApprovedEvent extends WorkerTelemetryEventBase {
  event: "worker-approved";
  blocker_id: string;
  approved_by: "operator" | "policy";
  operator_id?: string;
  policy_applied?: string;
}

/**
 * Worker rejected - approval denied.
 */
export interface WorkerRejectedEvent extends WorkerTelemetryEventBase {
  event: "worker-rejected";
  blocker_id: string;
  rejected_by: "operator" | "policy" | "timeout";
  operator_id?: string;
  rejection_reason?: string;
}

/**
 * Worker auto-approved - policy auto-approved.
 */
export interface WorkerAutoApprovedEvent extends WorkerTelemetryEventBase {
  event: "worker-auto-approved";
  blocker_id: string;
  approval_type: "destructive" | "cost" | "security" | "ambiguous" | "external";
  description: string;
  policy_applied: string;
}

/**
 * Worker result - execution completed.
 */
export interface WorkerResultEvent extends WorkerTelemetryEventBase {
  event: "worker-result";
  status: "success" | "failure" | "blocked";
  exit_code: number;
  step_cursor: string;
  result_file?: string;
  compact_return?: Record<string, unknown>;
  error_message?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Foreman Delegated Mode Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Worker acknowledged - worker read packet and computed SHA, emitted before any work output.
 */
export interface WorkerAcknowledgedEvent extends WorkerTelemetryEventBase {
  event: "worker-acknowledged";
  worker_id: string;
  packet_sha: string;
}

/**
 * Worker assignment attempted - Foreman trying to assign worker.
 */
export interface WorkerAssignmentAttemptedEvent extends WorkerTelemetryEventBase {
  event: "worker-assignment-attempted";
  assignment_type: "subagent" | "external-process" | "human-handoff";
}

/**
 * Worker assigned - Foreman successfully assigned worker.
 */
export interface WorkerAssignedEvent extends WorkerTelemetryEventBase {
  event: "worker-assigned";
  assignment_type: "subagent" | "external-process" | "human-handoff";
  subagent_session_id?: string;
  process_pid?: number;
  handoff_token?: string;
}

/**
 * Worker assignment failed - Could not assign worker.
 */
export interface WorkerAssignmentFailedEvent extends WorkerTelemetryEventBase {
  event: "worker-assignment-failed";
  reason: "no-subagent-support" | "process-spawn-failed" | "provider-unavailable" | "timeout";
}

/**
 * Provider selected - dispatch chose a provider/adapter pair.
 */
export interface ProviderSelectedEvent extends WorkerTelemetryEventBase {
  event: "provider-selected";
  requested_role: "worker";
  selected_provider: string | null;
  selected_adapter: string;
  selection_reason: string;
  override_source?: string;
  fallback_from?: string;
  fallback_reason?: string;
  providers_tried?: string[];
}

/**
 * Provider fallback attempted - selector moved to another source/mechanism.
 */
export interface ProviderFallbackAttemptedEvent extends WorkerTelemetryEventBase {
  event: "provider-fallback-attempted";
  requested_role: "worker";
  fallback_from: string;
  fallback_reason: string;
  providers_tried?: string[];
}

/**
 * Provider exhausted - no provider could be selected before delegation path.
 */
export interface ProviderExhaustedEvent extends WorkerTelemetryEventBase {
  event: "provider-exhausted";
  requested_role: "worker";
  selected_adapter: string;
  reason: string;
  providers_tried?: string[];
}

/**
 * Provider forbidden - provider blocked by role policy before dispatch.
 */
export interface ProviderForbiddenEvent extends WorkerTelemetryEventBase {
  event: "provider-forbidden";
  requested_role: "worker";
  selected_provider: string | null;
  reason: "role-disabled" | "not-in-policy";
  policy_providers?: string[];
}

/**
 * Escalation initiated - No worker available, escalating to human.
 */
export interface EscalationInitiatedEvent extends WorkerTelemetryEventBase {
  event: "escalation-initiated";
  reason: string;
  recommended_action: "manual-dispatch" | "provider-config" | "subagent-enable";
}

/**
 * Union type of all worker telemetry events.
 */
export type WorkerTelemetryEvent =
  | WorkerLaunchEvent
  | WorkerAcknowledgedEvent
  | WorkerHeartbeat
  | WorkerBlockedEvent
  | WorkerApprovedEvent
  | WorkerRejectedEvent
  | WorkerAutoApprovedEvent
  | WorkerResultEvent
  | WorkerAssignmentAttemptedEvent
  | WorkerAssignedEvent
  | WorkerAssignmentFailedEvent
  | ProviderSelectedEvent
  | ProviderFallbackAttemptedEvent
  | ProviderExhaustedEvent
  | ProviderForbiddenEvent
  | EscalationInitiatedEvent;

// ─────────────────────────────────────────────────────────────────────────────
// State Machine Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a state is terminal (no further transitions expected).
 */
export function isTerminalState(state: WorkerDispatchState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Check if a state represents an active worker (telemetry expected).
 */
export function isActiveState(state: WorkerDispatchState): boolean {
  return ACTIVE_STATES.includes(state);
}

/**
 * Check if state is pre-launch (worker not yet started).
 */
export function isPreLaunchState(state: WorkerDispatchState): boolean {
  return PRE_LAUNCH_STATES.includes(state);
}

/**
 * Get the timeout configuration with defaults applied.
 */
export function resolveTimeoutConfig(
  config?: Partial<WorkerTimeoutConfig>,
): WorkerTimeoutConfig {
  return {
    launch_to_first_heartbeat_ms:
      config?.launch_to_first_heartbeat_ms ?? DEFAULT_TIMEOUTS.launch_to_first_heartbeat_ms,
    heartbeat_interval_ms:
      config?.heartbeat_interval_ms ?? DEFAULT_TIMEOUTS.heartbeat_interval_ms,
    orphan_timeout_ms:
      config?.orphan_timeout_ms ?? DEFAULT_TIMEOUTS.orphan_timeout_ms,
    approval_timeout_ms:
      config?.approval_timeout_ms ?? DEFAULT_TIMEOUTS.approval_timeout_ms,
    ack_to_first_heartbeat_ms:
      config?.ack_to_first_heartbeat_ms ?? DEFAULT_TIMEOUTS.ack_to_first_heartbeat_ms,
  };
}

/**
 * Delegated-mode runtime states (Foreman coordination states).
 */
export type DelegatedRuntimeState =
  | "delegated"          // Packet ready, awaiting assignment
  | "assigning"          // Attempting worker assignment
  | "worker-assigned"    // Worker confirmed assigned
  | "waiting-for-worker" // Worker expected but not yet active
  | "escalating"         // No worker available, escalating
  | "worker-unavailable"; // Escalation complete, human needed

/**
 * Derive the current dispatch state from events and configuration.
 *
 * This is the core state machine function that determines the current
 * state based on telemetry events and timeout thresholds.
 *
 * For delegated mode, also considers Foreman coordination events:
 * - worker-assignment-attempted
 * - worker-assigned
 * - worker-assignment-failed
 * - escalation-initiated
 */
export function deriveDispatchState(
  events: WorkerTelemetryEvent[],
  config: WorkerTimeoutConfig,
  now: Date = new Date(),
): WorkerDispatchState {
  // Sort events by timestamp
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  // Find result event (terminal)
  const resultEvent = sorted.find((e): e is WorkerResultEvent => e.event === "worker-result");
  if (resultEvent) {
    return resultEvent.status === "success" ? "completed" : "failed";
  }

  // Find blocked event
  const blockedEvents = sorted.filter((e): e is WorkerBlockedEvent => e.event === "worker-blocked");
  const lastBlocked = blockedEvents.at(-1);
  if (lastBlocked) {
    // Check for approval after this block
    const approvalEvents = sorted.filter(
      (e): e is WorkerApprovedEvent | WorkerAutoApprovedEvent =>
        (e.event === "worker-approved" || e.event === "worker-auto-approved") &&
        new Date(e.timestamp) > new Date(lastBlocked.timestamp),
    );

    if (approvalEvents.length === 0) {
      // Still blocked - check for timeout
      const blockedMs = now.getTime() - new Date(lastBlocked.timestamp).getTime();
      if (blockedMs > config.approval_timeout_ms) {
        return "failed";
      }
      return "waiting-for-approval";
    }
    // Approved - continue checking heartbeats below
  }

  // Find rejection event - context aware
  // Only treat rejection as terminal if it's relevant to current unresolved cycle
  // A rejection is relevant if:
  // 1. It occurred after the most recent approval (if any approvals exist), OR
  // 2. It matches the blocker_id of the current unresolved blocked event
  const rejectionEvents = sorted.filter((e): e is WorkerRejectedEvent => e.event === "worker-rejected");
  if (rejectionEvents.length > 0) {
    // Find the most recent approval timestamp (if any approvals exist)
    const lastApproval = sorted
      .filter((e): e is WorkerApprovedEvent | WorkerAutoApprovedEvent =>
        e.event === "worker-approved" || e.event === "worker-auto-approved"
      )
      .at(-1);
    const lastApprovalTimestamp = lastApproval ? new Date(lastApproval.timestamp).getTime() : 0;

    // Find if there's a current unresolved blocked event with a blocker_id
    const currentBlocked = lastBlocked;
    const currentBlockerId = currentBlocked?.blocker_id;

    // Check for relevant rejections
    const relevantRejection = rejectionEvents.find((rejection) => {
      const rejectionTimestamp = new Date(rejection.timestamp).getTime();

      // Rejection is relevant if it happened after the last approval
      if (rejectionTimestamp > lastApprovalTimestamp) {
        return true;
      }

      // Or if it matches the current unresolved blocked event's blocker_id
      if (currentBlockerId && rejection.blocker_id === currentBlockerId) {
        return true;
      }

      return false;
    });

    if (relevantRejection) {
      return "failed";
    }
  }

  // Check heartbeats
  const heartbeats = sorted.filter((e): e is WorkerHeartbeat => e.event === "worker-heartbeat");
  const lastHeartbeat = heartbeats.at(-1);

  if (lastHeartbeat) {
    const msSinceHeartbeat = now.getTime() - new Date(lastHeartbeat.timestamp).getTime();

    // Check for orphan timeout
    if (msSinceHeartbeat > config.orphan_timeout_ms) {
      return "orphaned";
    }

    // Check for blocked (stale heartbeat)
    if (msSinceHeartbeat > config.heartbeat_interval_ms) {
      return "blocked";
    }

    // Active worker
    return "running";
  }

  // No heartbeats yet — check for worker-acknowledged event
  const acknowledgedEvent = sorted.find(
    (e): e is WorkerAcknowledgedEvent => e.event === "worker-acknowledged",
  );
  if (acknowledgedEvent) {
    // Worker acknowledged packet but has not yet sent a heartbeat
    // Check if the acknowledgement has aged out
    const msSinceAck = now.getTime() - new Date(acknowledgedEvent.timestamp).getTime();
    if (msSinceAck > config.ack_to_first_heartbeat_ms) {
      // Ack timeout — worker never started actual work
      return "failed";
    }
    return "acknowledged";
  }

  // No heartbeats yet - check for launch
  const launchEvent = sorted.find((e): e is WorkerLaunchEvent => e.event === "worker-launch");
  if (launchEvent) {
    const msSinceLaunch = now.getTime() - new Date(launchEvent.timestamp).getTime();

    // Check for launch timeout
    if (msSinceLaunch > config.launch_to_first_heartbeat_ms) {
      return "blocked";
    }

    return "launching";
  }

  // No launch event - check for provider assignment
  // This would require external knowledge, default to packet-created
  return "packet-created";
}

/**
 * Determine if a state transition is valid.
 */
export function isValidTransition(
  from: WorkerDispatchState,
  to: WorkerDispatchState,
): boolean {
  // Cannot transition from terminal states
  if (isTerminalState(from)) {
    return false;
  }

  // Define valid transitions
  const validTransitions: Record<WorkerDispatchState, WorkerDispatchState[]> = {
    "packet-created": ["delegated", "launching", "acknowledged", "running", "failed"],
    "delegated": ["launching", "acknowledged", "running", "completed", "failed", "blocked"],
    "launching": ["acknowledged", "running", "waiting-for-approval", "blocked", "completed", "failed"],
    "acknowledged": ["running", "failed"],
    "running": ["waiting-for-approval", "blocked", "completed", "failed", "orphaned"],
    "waiting-for-approval": ["running", "completed", "failed"],
    "blocked": ["running", "completed", "failed", "orphaned"],
    "completed": [],
    "failed": [],
    "orphaned": [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}

/**
 * Create a state history entry.
 */
export function createStateHistoryEntry(
  state: WorkerDispatchState,
  evidence?: string,
): StateHistoryEntry {
  return {
    state,
    entered_at: new Date().toISOString(),
    evidence,
  };
}
