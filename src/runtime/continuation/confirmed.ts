import { loadState, writeState } from "../state.js";
import { validateEnvelope } from "../verification/envelope.js";
import { writeCheckpoint } from "../checkpoint.js";
import { appendAuditEvent } from "../audit/logger.js";
import { selectExecutionAdapter } from "../../loop/execution-adapter.js";
import type { ExecutionAdapterMode } from "../../loop/execution-adapter.js";
import type { ContinuationApprovalEnvelope } from "../verification/envelope.js";

export interface ConfirmedContinuationRequest {
  artifact_dir: string;
  envelope: ContinuationApprovalEnvelope;
  adapterOverride?: ExecutionAdapterMode;
  executionWindow?: unknown; // typed in Issue D (POL-94)
}

export type ConfirmedContinuationResult =
  | { ok: true; child_id: string; compact_return: { status: string; state_updated: boolean } }
  | { ok: false; rejection: { check: string; reason: string; expected?: string; actual?: string; detail?: string } };

/**
 * Dispatch a confirmed continuation: validate, checkpoint, acquire active_child lease,
 * and stub the adapter call. Full adapter dispatch wired in Issue C (POL-93).
 */
export async function dispatchConfirmedContinuation(
  request: ConfirmedContinuationRequest,
): Promise<ConfirmedContinuationResult> {
  const { artifact_dir, envelope } = request;

  // Step 1: fresh state read — never use a caller-supplied cached copy
  const state = await loadState(artifact_dir);
  if (state === null) {
    return { ok: false, rejection: { check: "state", reason: "state_not_found" } };
  }

  // Step 2: paranoid re-validation after the pendingConfirmations gate
  const validation = validateEnvelope(state, envelope);
  if (!validation.ok) {
    return { ok: false, rejection: validation.failure };
  }

  // Step 3: execution window check — full validation in Issue D (POL-94)
  // Pass-through if executionWindow not provided.

  // Step 4: recovery state detection stub — full implementation in Issue E (POL-95)
  if (state.active_child) {
    console.warn(
      `[confirmed] active_child="${state.active_child}" set on entry — possible interrupted-before-dispatch; recovery not yet implemented`,
    );
  }

  // Step 5: pre-dispatch checkpoint
  await writeCheckpoint(artifact_dir, state.step_cursor);

  const nextChild = validation.next_child;

  // Step 6: acquire active_child lease — single writeState call sets both fields atomically
  await writeState(artifact_dir, {
    ...state,
    active_child: nextChild,
    continuation_epoch: (state.continuation_epoch ?? 0) + 1,
  });

  // Step 7: record mutation_approved after state is durably written
  await appendAuditEvent(artifact_dir, {
    event_type: "mutation_approved",
    run_id: state.run_id,
    step_cursor: state.step_cursor,
    operator: "mcp",
    operation: "loop_continue_confirmed",
    approval_fingerprint: envelope.fingerprint,
    result: "ok",
    metadata: { next_child: nextChild },
  });

  // Step 8: adapter selection + autoDispatch gating
  const selection = selectExecutionAdapter({
    explicitAdapter: request.adapterOverride,
    insideAgentSession: true,
    nativeSubtaskAvailable: true,
    crossAgentConfigured: false,
    tokenBudgetLow: false,
  });

  if (!selection.autoDispatch) {
    return {
      ok: false,
      rejection: {
        check: "adapter_mode",
        reason: "manual_dispatch_required",
        detail: `Adapter "${selection.mode}" requires manual operator dispatch`,
      },
    };
  }

  // Step 9: stub — adapter dispatch wired in Issue C (POL-93)
  return {
    ok: true,
    child_id: nextChild,
    compact_return: { status: "dispatched-stub", state_updated: false },
  };
}
