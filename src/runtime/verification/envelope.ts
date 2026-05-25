import { computeStateFingerprint } from "./fingerprint.js";
import { selectNextChild } from "../scheduling/child-selector.js";
import type { CurrentState } from "../../types/runtime-state.js";

export interface ContinuationApprovalEnvelope {
  run_id: string;
  expected_step_cursor: string;
  fingerprint: string;
  runtime_generation: number;
  issued_at: string;
  expires_at: string;
  nonce: string;
  requested_action: "loop_continue";
}

export type EnvelopeValidationFailure = {
  check: string;
  reason: string;
  expected?: string;
  actual?: string;
};

export type EnvelopeValidationResult =
  | { ok: true; next_child: string }
  | { ok: false; failure: EnvelopeValidationFailure };

export function validateEnvelope(
  state: CurrentState,
  envelope: ContinuationApprovalEnvelope
): EnvelopeValidationResult {
  if (envelope.requested_action !== "loop_continue") {
    return {
      ok: false,
      failure: {
        check: "requested_action",
        reason: "unsupported_action",
        expected: "loop_continue",
        actual: envelope.requested_action,
      },
    };
  }

  if (state.status !== "running") {
    return {
      ok: false,
      failure: { check: "status", reason: "run_not_continuable", actual: state.status },
    };
  }

  const activeChild = state.active_child ?? "";
  if (activeChild !== "") {
    return {
      ok: false,
      failure: { check: "active_child", reason: "concurrent_execution", actual: activeChild },
    };
  }

  if (state.run_id !== envelope.run_id) {
    return {
      ok: false,
      failure: {
        check: "run_id",
        reason: "run_id_mismatch",
        expected: envelope.run_id,
        actual: state.run_id,
      },
    };
  }

  if (state.step_cursor !== envelope.expected_step_cursor) {
    return {
      ok: false,
      failure: {
        check: "step_cursor",
        reason: "step_cursor_mismatch",
        expected: envelope.expected_step_cursor,
        actual: state.step_cursor,
      },
    };
  }

  const stateGeneration = state.runtime_generation ?? 0;
  if (stateGeneration !== envelope.runtime_generation) {
    return {
      ok: false,
      failure: {
        check: "runtime_generation",
        reason: "runtime_generation_mismatch",
        expected: String(envelope.runtime_generation),
        actual: String(stateGeneration),
      },
    };
  }

  const currentFingerprint = computeStateFingerprint({ state, approvalNonce: envelope.nonce });
  if (currentFingerprint !== envelope.fingerprint) {
    return {
      ok: false,
      failure: { check: "fingerprint", reason: "state_mutated_since_approval" },
    };
  }

  const nextChild = selectNextChild(state);
  if (nextChild === null) {
    return { ok: false, failure: { check: "next_child", reason: "no_open_children" } };
  }

  if (new Date(envelope.expires_at) <= new Date()) {
    return { ok: false, failure: { check: "expires_at", reason: "approval_expired" } };
  }

  return { ok: true, next_child: nextChild };
}
