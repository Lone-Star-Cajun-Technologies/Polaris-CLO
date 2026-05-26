import path from "node:path";
import { writeFile } from "node:fs/promises";
import { loadState, writeState, getArtifactDir } from "../state.js";
import { validateEnvelope } from "../verification/envelope.js";
import { writeCheckpoint } from "../checkpoint.js";
import { appendAuditEvent } from "../audit/logger.js";
import { selectExecutionAdapter } from "../../loop/execution-adapter.js";
import { AgentSubtaskAdapter } from "../../loop/adapters/agent-subtask.js";
import { validateWindow, decrementWindow } from "../execution-window.js";
import { computeStateFingerprint } from "../verification/fingerprint.js";
import type { ExecutionWindow } from "../execution-window.js";
import type { ExecutionAdapterMode } from "../../loop/execution-adapter.js";
import type { ExecutionAdapter } from "../../loop/adapters/types.js";
import type { ContinuationApprovalEnvelope } from "../verification/envelope.js";

export interface CompactReturn {
  status: string;
  state_updated: boolean;
  [key: string]: unknown;
}

export interface ConfirmedContinuationRequest {
  artifact_dir: string;
  envelope: ContinuationApprovalEnvelope;
  adapterOverride?: ExecutionAdapterMode;
  executionWindow?: ExecutionWindow;
  /** For test injection: override the adapter factory. */
  _adapterFactory?: () => ExecutionAdapter;
}

export type ConfirmedContinuationResult =
  | { ok: true; child_id: string; compact_return: CompactReturn }
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

  // Step 3: execution window validation
  if (request.executionWindow) {
    const fingerprint = computeStateFingerprint({ state, approvalNonce: request.executionWindow.run_id });
    const windowResult = validateWindow(state, request.executionWindow, fingerprint);
    if (!windowResult.ok) {
      return { ok: false, rejection: { check: "execution_window", reason: windowResult.reason } };
    }
  }

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

  // Decrement window after lease acquired — persist as side-file
  if (request.executionWindow) {
    const decremented = decrementWindow(request.executionWindow);
    // Persist decremented window to side-file (not in CurrentState)
    const windowFile = path.join(getArtifactDir(artifact_dir), "execution-window.json");
    await writeFile(windowFile, JSON.stringify(decremented, null, 2) + "\n", "utf-8");
  }

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

  // Step 9: dispatch boundary assertion
  if (!nextChild) throw new Error("dispatch_invariant_violated: nextChild must be non-empty at dispatch boundary");

  // Step 10: emit worker_dispatched audit event before adapter call
  await appendAuditEvent(artifact_dir, {
    event_type: "worker_dispatched",
    run_id: state.run_id,
    step_cursor: state.step_cursor,
    child_id: nextChild,
    operator: "mcp",
    operation: "confirmed_dispatch",
    result: "ok",
    metadata: { adapter_mode: selection.mode },
  });

  // Step 11: build bootstrap packet and call adapter.dispatch()
  const packet = {
    schema_version: "1.0",
    run_id: state.run_id,
    cluster_id: state.cluster_id,
    active_child: nextChild,
    state_file: `${artifact_dir}/current-state.json`,
    telemetry_file: `${artifact_dir}/telemetry.jsonl`,
  };

  const adapter = request._adapterFactory ? request._adapterFactory() : new AgentSubtaskAdapter();

  let compactReturn: CompactReturn;
  let dispatchResultCode = 0;
  try {
    const dispatchResult = await adapter.dispatch(packet, { provider: "agent-subtask" });
    dispatchResultCode = dispatchResult.exit_code;
    // Parse summary if available; fall back to inferring done state from exit_code
    if (dispatchResult.summary) {
      try {
        const parsed = JSON.parse(dispatchResult.summary) as Record<string, unknown>;
        compactReturn = {
          status: typeof parsed["status"] === "string" ? parsed["status"] : "done",
          state_updated: typeof parsed["state_updated"] === "boolean" ? parsed["state_updated"] : dispatchResult.exit_code === 0,
          exit_code: dispatchResult.exit_code,
        };
      } catch {
        compactReturn = { status: "done", state_updated: dispatchResult.exit_code === 0, exit_code: dispatchResult.exit_code };
      }
    } else {
      compactReturn = { status: "done", state_updated: dispatchResult.exit_code === 0, exit_code: dispatchResult.exit_code };
    }
  } catch {
    // Adapter not available in this environment — graceful fallback to stub behavior
    compactReturn = { status: "dispatched-stub", state_updated: false };
  }

  // Step 12: emit worker_result_received audit event
  await appendAuditEvent(artifact_dir, {
    event_type: "worker_result_received",
    run_id: state.run_id,
    step_cursor: state.step_cursor,
    child_id: nextChild,
    operator: "mcp",
    operation: "confirmed_dispatch",
    result: compactReturn.status === "dispatched-stub" ? "error" : "ok",
    metadata: { exit_code: dispatchResultCode, status: compactReturn.status },
  });

  // Step 13: handle state_updated: false — defensively clear active_child
  if (compactReturn.state_updated === false) {
    await writeState(artifact_dir, { ...state, active_child: "" });
    await appendAuditEvent(artifact_dir, {
      event_type: "recovery_attempted",
      run_id: state.run_id,
      step_cursor: state.step_cursor,
      operator: "mcp",
      operation: "confirmed_dispatch_recovery",
      result: "ok",
      metadata: { reason: "state_updated_false" },
    });
  }

  return { ok: true, child_id: nextChild, compact_return: compactReturn };
}
