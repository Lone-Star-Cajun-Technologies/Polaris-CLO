/**
 * execution-window.ts — Execution window support for Alice/Delegator
 *
 * Alice/Delegator compatibility principles:
 *
 * 1. Approval tokens must be provider-agnostic (no Alice-specific fields).
 *    ExecutionWindow carries only generic orchestration fields; Alice is one
 *    possible issuer, not the assumed issuer.
 *
 * 2. Dry-run contract must remain stable — Alice implements against it without
 *    version coupling. The shape of ExecutionWindow and WindowValidationResult
 *    must not change in a breaking way without a schema_version bump in the
 *    broader protocol.
 *
 * 3. Fingerprint must be deterministic — Alice can re-run the dry-run for the
 *    same state and obtain the same fingerprint. This is guaranteed by
 *    computeStateFingerprint in src/runtime/verification/fingerprint.ts.
 *
 * 4. Confirmations must be idempotent at protocol level — validateWindow is
 *    pure and side-effect-free; calling it multiple times for the same inputs
 *    yields the same result. Callers are responsible for persisting
 *    decremented windows exactly once.
 */

import type { CurrentState } from "../types/runtime-state.js";

// Re-export for convenience of callers that import from this module.
export type { CurrentState };

/**
 * An execution window authorises a bounded number of continuations for a
 * specific run, within a specific time range, optionally constrained to
 * particular child types.
 */
export interface ExecutionWindow {
  run_id: string;
  max_continuations: number;
  /** ISO-8601 timestamp — window becomes valid at or after this instant. */
  valid_from: string;
  /** ISO-8601 timestamp — window expires at this instant (exclusive). */
  valid_until: string;
  allowed_child_types: Array<"analyze" | "implement">;
  /** SHA-256 fingerprint of the CurrentState at the time the window was issued. */
  state_fingerprint_at_issue: string;
}

/**
 * Result type for validateWindow.
 *
 *   { ok: true }                   — all checks passed; the window is valid.
 *   { ok: false; reason; detail? } — validation failed; reason is a stable
 *                                    machine-readable code.
 */
export type WindowValidationResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: string };

/**
 * Validates an ExecutionWindow against the current runtime state and
 * fingerprint. All checks must pass for the result to be `{ ok: true }`.
 *
 * Checks performed (in order):
 *   1. run_id_mismatch           — window.run_id must equal state.run_id
 *   2. window_not_yet_valid      — valid_from must be in the past or now
 *   3. window_expired            — valid_until must be strictly in the future
 *   4. window_exhausted          — max_continuations must be > 0
 *   5. state_fingerprint_drifted — currentFingerprint must exactly match
 *                                  window.state_fingerprint_at_issue
 *
 * TODO: Add a check on allowed_child_types once the child type of the
 *       proposed continuation is available at the call site.  The field is
 *       intentionally included in ExecutionWindow now so that the protocol
 *       shape is stable when that check is wired in.
 */
export function validateWindow(
  state: CurrentState,
  window: ExecutionWindow,
  currentFingerprint: string,
): WindowValidationResult {
  // 1. run_id must match
  if (window.run_id !== state.run_id) {
    return {
      ok: false,
      reason: "run_id_mismatch",
      detail: `window.run_id=${window.run_id} state.run_id=${state.run_id}`,
    };
  }

  const now = new Date();

  // 2. Window must have started
  if (new Date(window.valid_from) > now) {
    return {
      ok: false,
      reason: "window_not_yet_valid",
      detail: `valid_from=${window.valid_from} now=${now.toISOString()}`,
    };
  }

  // 3. Window must not have expired
  if (new Date(window.valid_until) <= now) {
    return {
      ok: false,
      reason: "window_expired",
      detail: `valid_until=${window.valid_until} now=${now.toISOString()}`,
    };
  }

  // 4. Continuations remaining
  if (window.max_continuations <= 0) {
    return {
      ok: false,
      reason: "window_exhausted",
      detail: `max_continuations=${window.max_continuations}`,
    };
  }

  // 5. Fingerprint must match exactly — no tolerance
  if (currentFingerprint !== window.state_fingerprint_at_issue) {
    return {
      ok: false,
      reason: "state_fingerprint_drifted",
      detail: `expected=${window.state_fingerprint_at_issue} got=${currentFingerprint}`,
    };
  }

  // TODO: Check allowed_child_types against the proposed continuation's child
  // type once that information is threaded through to this call site.

  return { ok: true };
}

/**
 * Returns a new ExecutionWindow with max_continuations decremented by 1.
 *
 * Does NOT mutate the input window.  The caller is responsible for persisting
 * the returned window exactly once to ensure idempotency at the protocol level.
 */
export function decrementWindow(window: ExecutionWindow): ExecutionWindow {
  return {
    ...window,
    max_continuations: window.max_continuations - 1,
  };
}
