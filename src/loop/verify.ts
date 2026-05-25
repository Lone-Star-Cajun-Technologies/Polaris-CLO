import { createHash } from "node:crypto";
import type { CurrentState } from "../types/runtime-state.js";

export function computeStateFingerprint(state: CurrentState): string {
  const canonical = JSON.stringify({
    run_id: state.run_id,
    step_cursor: state.step_cursor,
    open_children: [...state.open_children].sort(),
    active_child: state.active_child ?? null,
    status: state.status,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function selectNextChild(state: CurrentState): string | null {
  if (state.open_children.length === 0) return null;
  return [...state.open_children].sort()[0] ?? null;
}

export interface ApprovalEnvelope {
  run_id: string;
  expected_step_cursor: string;
  expected_next_child: string;
  state_fingerprint: string;
  approved_at: string;
  expires_at: string;
}

export type VerificationFailure = {
  check: string;
  reason: string;
  expected?: string;
  actual?: string;
};

export type VerificationResult =
  | { ok: true; next_child: string }
  | { ok: false; failure: VerificationFailure };

export function verifyApprovalEnvelope(
  state: CurrentState,
  envelope: ApprovalEnvelope
): VerificationResult {
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

  const currentFingerprint = computeStateFingerprint(state);
  if (currentFingerprint !== envelope.state_fingerprint) {
    return {
      ok: false,
      failure: { check: "state_fingerprint", reason: "state_mutated_since_approval" },
    };
  }

  const nextChild = selectNextChild(state);
  if (nextChild === null) {
    return { ok: false, failure: { check: "next_child", reason: "no_open_children" } };
  }

  if (nextChild !== envelope.expected_next_child) {
    return {
      ok: false,
      failure: {
        check: "expected_next_child",
        reason: "next_child_mismatch",
        expected: envelope.expected_next_child,
        actual: nextChild,
      },
    };
  }

  if (new Date(envelope.expires_at) <= new Date()) {
    return { ok: false, failure: { check: "expires_at", reason: "approval_expired" } };
  }

  return { ok: true, next_child: nextChild };
}
