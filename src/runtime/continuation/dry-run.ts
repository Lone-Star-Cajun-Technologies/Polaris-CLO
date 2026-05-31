import { randomUUID } from "node:crypto";
import { loadState } from "../state.js";
import { computeStateFingerprint } from "../verification/fingerprint.js";
import { selectNextChild } from "../scheduling/child-selector.js";
import { appendAuditEvent } from "../audit/logger.js";
import type { ContinuationApprovalEnvelope } from "../verification/envelope.js";

export interface DryRunRequest {
  artifact_dir: string;
  expected_step_cursor: string;
}

export interface DryRunPreview {
  next_child: string;
  fingerprint: string;
  // Pre-filled template; caller supplies issued_at and expires_at before submitting
  approval_template: Omit<ContinuationApprovalEnvelope, "issued_at" | "expires_at">;
}

export type DryRunResult =
  | { ok: true; preview: DryRunPreview }
  | { ok: false; rejection: { reason: string; expected?: string; actual?: string; detail?: string } };

export async function executeDryRun(request: DryRunRequest): Promise<DryRunResult> {
  const state = await loadState(request.artifact_dir);

  if (state === null) {
    return {
      ok: false,
      rejection: {
        reason: "run_not_found",
        detail: `No state found in .taskchain_artifacts/${request.artifact_dir}`,
      },
    };
  }

  if (state.status !== "running") {
    return {
      ok: false,
      rejection: { reason: "run_not_continuable", expected: "running", actual: state.status },
    };
  }

  const activeChild = state.active_child ?? "";
  if (activeChild !== "") {
    return {
      ok: false,
      rejection: { reason: "concurrent_execution", detail: `active_child is set: ${activeChild}` },
    };
  }

  if (state.step_cursor !== request.expected_step_cursor) {
    return {
      ok: false,
      rejection: {
        reason: "step_cursor_mismatch",
        expected: request.expected_step_cursor,
        actual: state.step_cursor ?? undefined,
      },
    };
  }

  const nextChild = selectNextChild(state);
  if (nextChild === null) {
    return { ok: false, rejection: { reason: "no_open_children" } };
  }

  // Nonce ties this fingerprint to a single approval issuance — prevents replay
  const nonce = randomUUID();
  const fingerprint = computeStateFingerprint({ state, approvalNonce: nonce });

  await appendAuditEvent(request.artifact_dir, {
    event_type: "dry_run_executed",
    run_id: state.run_id,
    step_cursor: state.step_cursor ?? "",
    operator: "mcp",
    operation: "loop_continue_dry_run",
    child_id: nextChild,
    result: "preview",
  });

  return {
    ok: true,
    preview: {
      next_child: nextChild,
      fingerprint,
      approval_template: {
        run_id: state.run_id,
        expected_step_cursor: state.step_cursor ?? "",
        fingerprint,
        runtime_generation: state.runtime_generation ?? 0,
        nonce,
        requested_action: "loop_continue",
      },
    },
  };
}
