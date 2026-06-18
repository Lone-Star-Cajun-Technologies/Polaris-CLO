/**
 * Polaris Dispatch Boundary Enforcement
 *
 * The dispatch boundary is a hard runtime constraint enforced by the Polaris
 * runtime. The parent/orchestrator MUST call `polaris loop dispatch` before
 * any child execution. Inline child execution by the parent/orchestrator is
 * FORBIDDEN. Models do not decide execution legality — the runtime owns it.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Allowed state transitions (enforced at runtime):
 *
 *   selected       → dispatched        (via polaris loop dispatch)
 *   dispatched     → worker-running    (via adapter dispatch)
 *   worker-running → worker-completed  (via worker CompactReturn)
 *   worker-completed → checkpointed    (via polaris loop continue)
 *   dispatched     → checkpointed      (worker wrote own completion)
 *   checkpointed   → dispatched        (via polaris loop dispatch, next child)
 *   checkpointed   → cluster-complete  (no remaining children)
 *   *              → blocked           (via polaris loop abort)
 *   *              → budget-exhausted  (via budget check)
 *
 * Disallowed transitions (hard failure + telemetry):
 *
 *   selected → completed               (no dispatch: inline completion)
 *   selected → checkpointed            (no dispatch: fake checkpoint)
 *   selected → implementation-inline   (parent doing child work directly)
 *   idle     → worker-completed        (worker completed without dispatch)
 *   idle     → checkpointed            (continue called without dispatch)
 * ──────────────────────────────────────────────────────────────────────────
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LoopState } from "./checkpoint.js";

// ──────────────────────────────────────────────────────────────────────────────
// Error constants
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Error emitted when the parent/orchestrator attempts inline child execution.
 * This is the canonical error message for dispatch boundary violations.
 */
export const INLINE_EXECUTION_ERROR =
  "Child execution requires dispatch boundary. Parent/orchestrator may not implement child inline. Use npx polaris loop dispatch.";

/**
 * Error emitted when PR creation is attempted without a passing Librarian gate.
 */
export const LIBRARIAN_GATE_ERROR =
  "PR creation requires Closeout Librarian gate. Generate packet with `polaris librarian packet <cluster-id>`, dispatch the Librarian, then re-run finalize.";

/**
 * Error emitted when `polaris loop continue` is called without a prior dispatch.
 */
export const DISPATCH_REQUIRED_ERROR =
  "Dispatch required before continuation. Call `npx polaris loop dispatch` first, then run the worker before calling continue.";

// ──────────────────────────────────────────────────────────────────────────────
// State machine types
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Logical states in the dispatch state machine.
 * These are derived from the combination of step_cursor, active_child,
 * dispatch_boundary epochs, and status.
 */
export type DispatchMachineState =
  | "idle"                  // No active child; awaiting dispatch (initial or post-checkpoint)
  | "dispatched"            // Dispatch called; worker not yet returned
  | "worker-running"        // Worker is actively executing (alias for dispatched)
  | "worker-completed"      // Worker returned; awaiting polaris loop continue
  | "checkpointed"          // Continue called; ready for next dispatch
  | "cluster-complete"      // All children done
  | "librarian-dispatched"  // Closeout Librarian session in flight
  | "librarian-complete"    // Librarian wrote sealed result; ready for PR creation
  | "blocked"               // Blocker recorded via polaris loop abort
  | "budget-exhausted";     // Budget cap reached

/**
 * Allowed transitions in the dispatch state machine.
 * Format: [from, to, command-that-drives-transition]
 */
export const ALLOWED_TRANSITIONS: readonly [DispatchMachineState, DispatchMachineState, string][] =
  [
    // Primary dispatch flow
    ["idle", "dispatched", "polaris loop dispatch"],
    ["checkpointed", "dispatched", "polaris loop dispatch"],
    ["dispatched", "worker-running", "adapter-dispatch"],
    ["worker-running", "worker-completed", "worker-compact-return"],
    ["dispatched", "worker-completed", "worker-compact-return"],
    ["worker-completed", "checkpointed", "polaris loop continue"],
    ["dispatched", "checkpointed", "polaris loop continue"],         // Worker wrote own completion
    ["checkpointed", "cluster-complete", "polaris loop continue"],

    // Halt paths (allowed from any operational state)
    ["idle", "blocked", "polaris loop abort"],
    ["dispatched", "blocked", "polaris loop abort"],
    ["worker-running", "blocked", "polaris loop abort"],
    ["worker-completed", "blocked", "polaris loop abort"],
    ["checkpointed", "blocked", "polaris loop abort"],

    // Budget exhaustion (allowed from any operational state)
    ["idle", "budget-exhausted", "budget-check"],
    ["dispatched", "budget-exhausted", "budget-check"],
    ["checkpointed", "budget-exhausted", "budget-check"],

    // Librarian phase (post cluster-complete, pre PR-creation)
    ["cluster-complete", "librarian-dispatched", "polaris librarian packet + dispatch"],
    ["librarian-dispatched", "librarian-complete", "librarian-sealed-result"],
    ["librarian-complete", "librarian-complete", "finalize-delivery-attempt"],  // delivery proceeds after librarian gate
  ] as const;

/**
 * Transitions that are explicitly forbidden. These represent illegal paths
 * that indicate inline execution or state machine violations.
 */
export const DISALLOWED_TRANSITIONS: readonly [string, string, string][] = [
  ["idle", "worker-completed", "attempted worker completion without prior dispatch"],
  ["idle", "checkpointed", "attempted continue without prior dispatch"],
  ["idle", "cluster-complete", "attempted cluster completion without dispatch"],
  ["selected", "completed", "attempted inline completion without dispatch"],
  ["selected", "checkpointed", "attempted checkpoint without dispatch"],
  ["selected", "implementation-inline", "parent doing child work directly (forbidden)"],
];

// ──────────────────────────────────────────────────────────────────────────────
// State derivation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Derive the logical dispatch machine state from the current LoopState.
 * Uses dispatch_boundary epochs when present; falls back to step_cursor
 * for states written before dispatch_boundary was introduced.
 */
export function getMachineState(state: LoopState): DispatchMachineState {
  // Terminal status values map directly to machine states
  if (state.status === "cluster-complete") return "cluster-complete";
  if (state.status === "blocked") return "blocked";
  if (state.status === "budget-exhausted") return "budget-exhausted";

  const boundary = state.dispatch_boundary;

  if (boundary) {
    const { dispatch_epoch, continue_epoch } = boundary;

    if (dispatch_epoch > continue_epoch) {
      // Dispatch was called more times than continue — either dispatched or worker-completed
      if (state.active_child && state.active_child !== "") {
        // active_child is set → dispatch in progress, worker may be running
        return "dispatched";
      }
      // active_child is cleared by worker → worker has returned, awaiting continue
      return "worker-completed";
    }

    // dispatch_epoch === continue_epoch
    if (dispatch_epoch === 0 && continue_epoch === 0) return "idle";
    return "checkpointed";
  }

  // Legacy fallback: no dispatch_boundary field present
  // Infer from step_cursor and active_child
  if (state.step_cursor === "dispatch") {
    return state.active_child ? "dispatched" : "worker-completed";
  }
  if (state.step_cursor === "checkpoint") {
    // Could be checkpointed (after continue) or worker-completed (before continue)
    // We cannot distinguish safely, so treat as checkpointed (the safe state)
    return "checkpointed";
  }
  return "idle";
}

// ──────────────────────────────────────────────────────────────────────────────
// Telemetry event types
// ──────────────────────────────────────────────────────────────────────────────

export type DispatchBoundaryEventType =
  | "invalid-inline-attempt"
  | "illegal-state-transition"
  | "dispatch-required";

export interface DispatchBoundaryViolationEvent {
  event: DispatchBoundaryEventType;
  run_id: string;
  child_id?: string;
  from_state?: string;
  to_state?: string;
  reason: string;
  timestamp: string;
}

/**
 * Append a dispatch boundary violation event to the telemetry file.
 * Must only emit on failure paths, not normal flow.
 *
 * Telemetry write failures are silently swallowed to ensure the
 * enforcement error is always surfaced to the caller.
 */
export function appendDispatchViolationEvent(
  telemetryFile: string,
  event: DispatchBoundaryViolationEvent,
): void {
  try {
    mkdirSync(dirname(telemetryFile), { recursive: true });
    appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // Telemetry write failure must not mask the underlying enforcement error
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Enforcement guards
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Assert that no child is already active before the parent/orchestrator
 * attempts to dispatch another child.
 *
 * If `active_child` is set, it means a previous dispatch was not properly
 * completed. The parent must NOT re-dispatch or complete inline — it must
 * halt and require manual resolution.
 *
 * @throws Error with INLINE_EXECUTION_ERROR if active_child is already set
 */
export function assertNoActiveChildBeforeDispatch(
  state: LoopState,
  telemetryFile: string,
): void {
  if (state.active_child && state.active_child !== "") {
    appendDispatchViolationEvent(telemetryFile, {
      event: "invalid-inline-attempt",
      run_id: state.run_id,
      child_id: state.active_child,
      from_state: getMachineState(state),
      to_state: "dispatched",
      reason: `active_child is already set to "${state.active_child}". Previous dispatch not completed. ` + INLINE_EXECUTION_ERROR,
      timestamp: new Date().toISOString(),
    });
    throw new Error(
      `active_child is already set to "${state.active_child}". Previous dispatch was not completed. ` +
        INLINE_EXECUTION_ERROR +
        " Use `npx polaris loop abort` to reset blocked state.",
    );
  }
}

/**
 * Assert that `polaris loop dispatch` was called before allowing
 * `polaris loop continue` to checkpoint state.
 *
 * The check uses dispatch_boundary epochs when present (primary),
 * and falls back to step_cursor for legacy states.
 *
 * @throws Error with DISPATCH_REQUIRED_ERROR if no dispatch preceded this continue
 */
export function assertContinueRequiresDispatch(
  state: LoopState,
  telemetryFile: string,
): void {
  const boundary = state.dispatch_boundary;
  let wasDispatched: boolean;

  if (boundary) {
    // Primary check: dispatch_epoch must be strictly greater than continue_epoch
    wasDispatched = boundary.dispatch_epoch > boundary.continue_epoch;
  } else {
    // Legacy fallback: no dispatch_boundary field present.
    //
    // dispatch.ts is the ONLY place that sets active_child. If active_child is
    // non-empty, dispatch was called (and the worker hasn't cleared it yet).
    // If step_cursor is "dispatch", dispatch was called (standard case).
    // If step_cursor is "checkpoint" with active_child cleared, we cannot tell
    // for certain — a conservative rejection would break existing flows, so we
    // accept it for legacy states (dispatch_boundary was not yet tracking).
    wasDispatched =
      (state.active_child !== "" && state.active_child !== undefined && state.active_child !== null) ||
      state.step_cursor === "dispatch" ||
      state.step_cursor === "checkpoint";
  }

  if (!wasDispatched) {
    appendDispatchViolationEvent(telemetryFile, {
      event: "dispatch-required",
      run_id: state.run_id,
      child_id: state.active_child || undefined,
      from_state: getMachineState(state),
      to_state: "checkpointed",
      reason: DISPATCH_REQUIRED_ERROR,
      timestamp: new Date().toISOString(),
    });
    throw new Error(DISPATCH_REQUIRED_ERROR);
  }
}

/**
 * Assert that a dispatched child completion is valid.
 *
 * Before the parent/orchestrator advances state to mark a child as completed,
 * verify that the dispatch boundary was properly established. If no dispatch
 * was recorded, the child cannot be marked as complete.
 *
 * @param state - Current (post-worker-return) loop state
 * @param childId - Child being completed
 * @param telemetryFile - Telemetry file path
 * @throws Error with INLINE_EXECUTION_ERROR if dispatch boundary was not set
 */
export function assertDispatchedBeforeCompletion(
  state: LoopState,
  childId: string,
  telemetryFile: string,
): void {
  const boundary = state.dispatch_boundary;
  let dispatchHappened: boolean;

  if (boundary) {
    // dispatch_epoch > continue_epoch means dispatch was called and not yet matched
    dispatchHappened =
      boundary.dispatch_epoch > boundary.continue_epoch &&
      (boundary.last_dispatched_child === childId || !boundary.last_dispatched_child);
  } else {
    // Legacy: step_cursor "dispatch" set by polaris loop dispatch
    dispatchHappened =
      state.step_cursor === "dispatch" ||
      // Worker may have already updated step_cursor to "checkpoint"
      (state.step_cursor === "checkpoint" && state.active_child === "");
  }

  if (!dispatchHappened) {
    appendDispatchViolationEvent(telemetryFile, {
      event: "illegal-state-transition",
      run_id: state.run_id,
      child_id: childId,
      from_state: getMachineState(state),
      to_state: "checkpointed",
      reason:
        `Attempted to complete child "${childId}" without a prior dispatch event. ` +
        INLINE_EXECUTION_ERROR,
      timestamp: new Date().toISOString(),
    });
    throw new Error(
      `Cannot complete child "${childId}" without a prior dispatch. ` + INLINE_EXECUTION_ERROR,
    );
  }
}

/**
 * Validate a state transition against the allowed transition graph.
 *
 * Returns an error message if the transition is illegal, or null if allowed.
 * Emits an `illegal-state-transition` telemetry event on rejection.
 * This function does NOT throw — the caller decides how to handle the error.
 */
export function validateTransition(
  from: DispatchMachineState,
  to: DispatchMachineState,
  runId: string,
  telemetryFile: string,
  childId?: string,
): string | null {
  const allowed = ALLOWED_TRANSITIONS.some(([f, t]) => f === from && t === to);
  if (allowed) return null;

  const reason = `Illegal state transition: ${from} → ${to}. Only transitions through polaris loop dispatch → worker → polaris loop continue are allowed.`;
  appendDispatchViolationEvent(telemetryFile, {
    event: "illegal-state-transition",
    run_id: runId,
    child_id: childId,
    from_state: from,
    to_state: to,
    reason,
    timestamp: new Date().toISOString(),
  });
  return reason;
}

// ──────────────────────────────────────────────────────────────────────────────
// Dispatch boundary record builders
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build an initial dispatch boundary record for a fresh state.
 */
export function initialDispatchBoundary(): LoopState["dispatch_boundary"] {
  return { dispatch_epoch: 0, continue_epoch: 0, last_dispatched_child: null };
}

/**
 * Return the updated dispatch_boundary after a dispatch call.
 * Increments dispatch_epoch and records the dispatched child.
 */
export function advanceDispatchEpoch(
  current: LoopState["dispatch_boundary"],
  childId: string,
): NonNullable<LoopState["dispatch_boundary"]> {
  const base = current ?? initialDispatchBoundary()!;
  return {
    dispatch_epoch: base.dispatch_epoch + 1,
    continue_epoch: base.continue_epoch,
    last_dispatched_child: childId,
  };
}

/**
 * Return the updated dispatch_boundary after a successful continue call.
 * Increments continue_epoch to match the consumed dispatch.
 */
export function advanceContinueEpoch(
  current: LoopState["dispatch_boundary"],
): NonNullable<LoopState["dispatch_boundary"]> {
  // If no boundary exists yet, return a fresh one without incrementing
  if (current === undefined || current === null) {
    return initialDispatchBoundary()!;
  }
  return {
    dispatch_epoch: current.dispatch_epoch,
    continue_epoch: current.continue_epoch + 1,
    last_dispatched_child: current.last_dispatched_child,
  };
}
