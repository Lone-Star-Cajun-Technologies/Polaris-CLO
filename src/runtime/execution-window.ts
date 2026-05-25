/**
 * Execution window support for Alice/Delegator integration.
 *
 * Alice/Delegator compatibility principles:
 * - Approval tokens must be provider-agnostic (no Alice-specific fields). The
 *   ExecutionWindow carries only protocol-neutral data so that any delegating
 *   agent can issue and validate windows without coupling to Alice internals.
 * - Dry-run contract must remain stable — Alice implements against it without
 *   version coupling. Fields added here must be additive and backward-compatible.
 * - Fingerprint must be deterministic — Alice can re-run the dry-run for the
 *   same state and obtain the same fingerprint, enabling offline pre-validation.
 * - Confirmations must be idempotent at protocol level. Calling validateWindow
 *   with the same inputs multiple times must return the same result; no side
 *   effects occur here (the caller is responsible for decrement/persist).
 */

import type { CurrentState } from "../types/runtime-state.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExecutionWindow {
  run_id: string;
  max_continuations: number;
  valid_from: string; // ISO-8601
  valid_until: string; // ISO-8601
  allowed_child_types: Array<"analyze" | "implement">;
  state_fingerprint_at_issue: string;
}

export type WindowValidationResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: string };

// ---------------------------------------------------------------------------
// validateWindow
// ---------------------------------------------------------------------------

/**
 * Validate an ExecutionWindow against the current runtime state and fingerprint.
 *
 * All checks must pass; the first failure is returned immediately.
 *
 * @param state            - Current runtime state loaded from artifact storage.
 * @param window           - The execution window issued by Alice/Delegator.
 * @param currentFingerprint - Fingerprint computed over the current state
 *                            (caller is responsible for computing this via
 *                            computeStateFingerprint from verification/fingerprint).
 */
export function validateWindow(
  state: CurrentState,
  window: ExecutionWindow,
  currentFingerprint: string
): WindowValidationResult {
  // 1. run_id must match — prevents cross-run token reuse.
  if (window.run_id !== state.run_id) {
    return { ok: false, reason: "run_id_mismatch" };
  }

  const now = new Date();

  // 2. Window must have already started.
  if (new Date(window.valid_from) > now) {
    return { ok: false, reason: "window_not_yet_valid" };
  }

  // 3. Window must not have expired.
  if (new Date(window.valid_until) <= now) {
    return { ok: false, reason: "window_expired" };
  }

  // 4. Remaining continuations must be positive.
  if (window.max_continuations <= 0) {
    return { ok: false, reason: "window_exhausted" };
  }

  // 5. Fingerprint must match exactly — any state drift since window issuance
  //    is treated as a security violation (no tolerance).
  if (currentFingerprint !== window.state_fingerprint_at_issue) {
    return { ok: false, reason: "state_fingerprint_drifted" };
  }

  // TODO: Check allowed_child_types against the child type that is about to be
  //   dispatched. This requires knowing the child type at call time (e.g. from
  //   the task map or the next-child selection result), which is not available
  //   through the CurrentState alone. The caller should perform this check after
  //   resolving the next child via selectNextChild(), comparing its type against
  //   window.allowed_child_types before proceeding.

  return { ok: true };
}

// ---------------------------------------------------------------------------
// decrementWindow
// ---------------------------------------------------------------------------

/**
 * Return a new ExecutionWindow with max_continuations decremented by 1.
 *
 * Does NOT mutate the input window. The caller is responsible for persisting
 * the returned window to durable storage before proceeding with the continuation.
 */
export function decrementWindow(window: ExecutionWindow): ExecutionWindow {
  return {
    ...window,
    max_continuations: window.max_continuations - 1,
  };
}
