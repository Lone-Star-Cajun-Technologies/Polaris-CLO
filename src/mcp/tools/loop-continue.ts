// HARD CONSTRAINTS — do not remove these comments:
// DO NOT implement unrestricted continuation (no open-ended "run everything" path)
// DO NOT implement arbitrary shell passthrough (no exec/spawn of user-provided commands)
// DO NOT implement direct git operations (no git commit/push from this handler)

import type { ContinuationApprovalEnvelope } from "../../runtime/verification/envelope.js";
import { validateEnvelope } from "../../runtime/verification/envelope.js";
import { appendAuditEvent } from "../../runtime/audit/logger.js";
import { loadState } from "../../runtime/state.js";
import { dispatchConfirmedContinuation } from "../../runtime/continuation/confirmed.js";
import type { ExecutionAdapterMode } from "../../loop/execution-adapter.js";

// Per-artifact-dir lock: prevents two concurrent confirmations from both passing
// validation before either writes active_child to disk. Set operations are
// synchronous so the check-and-add is atomic within a single Node.js event loop tick.
const pendingConfirmations = new Set<string>();

function parseEnvelope(args: Record<string, unknown>): ContinuationApprovalEnvelope & { artifact_dir: string } {
  const artifact_dir =
    typeof args["artifact_dir"] === "string" ? args["artifact_dir"] : "bootstrap-run";

  const required = [
    "run_id",
    "expected_step_cursor",
    "fingerprint",
    "nonce",
    "issued_at",
    "expires_at",
    "requested_action",
  ] as const;

  for (const key of required) {
    if (typeof args[key] !== "string") {
      throw new Error(`missing_or_invalid_field: ${key} must be a string`);
    }
  }

  if (typeof args["runtime_generation"] !== "number") {
    throw new Error("missing_or_invalid_field: runtime_generation must be a number");
  }

  if (args["requested_action"] !== "loop_continue") {
    throw new Error(
      `invalid_field: requested_action must be "loop_continue", got "${String(args["requested_action"])}"`,
    );
  }

  return {
    artifact_dir,
    run_id: args["run_id"] as string,
    expected_step_cursor: args["expected_step_cursor"] as string,
    fingerprint: args["fingerprint"] as string,
    runtime_generation: args["runtime_generation"] as number,
    issued_at: args["issued_at"] as string,
    expires_at: args["expires_at"] as string,
    nonce: args["nonce"] as string,
    requested_action: "loop_continue",
  };
}

/**
 * Handle a polaris_loop_continue_confirmed MCP tool call.
 *
 * Validates the supplied ContinuationApprovalEnvelope against the current live
 * state (fresh disk read — never cached). On success, dispatches the next child
 * via the confirmed continuation service and returns the dispatch result.
 *
 * Returns `{ ok: true, child_id, compact_return }` on success, or
 * `{ ok: false, rejection: { check, reason, ... } }` on any failure.
 */
export async function handleLoopContinueConfirmed(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Parse and validate input shape
  let parsed: ContinuationApprovalEnvelope & { artifact_dir: string };
  try {
    parsed = parseEnvelope(args);
  } catch (err) {
    return {
      ok: false,
      error: "invalid_input",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const { artifact_dir, ...envelope } = parsed;

  // Load state first — needed for audit events even if we reject early.
  // Always a fresh read, never cached.
  const state = await loadState(artifact_dir);
  if (state === null) {
    return {
      ok: false,
      error: "state_not_found",
      message: `No current-state.json found for artifact_dir="${artifact_dir}"`,
    };
  }

  // In-memory lock: if another confirmation is in flight for this artifact_dir,
  // reject immediately. Load state first so we can write a proper audit event.
  // Set operations are synchronous, so check+add is atomic within one event-loop tick.
  if (pendingConfirmations.has(artifact_dir)) {
    await appendAuditEvent(artifact_dir, {
      event_type: "mutation_rejected",
      run_id: state.run_id,
      step_cursor: state.step_cursor,
      operator: "mcp",
      operation: "loop_continue_confirmed",
      approval_fingerprint: envelope.fingerprint,
      result: "rejected",
      rejection_reason: "active_child: concurrent_execution",
    });
    return {
      ok: false,
      rejection: { check: "active_child", reason: "concurrent_execution" },
    };
  }
  pendingConfirmations.add(artifact_dir);

  try {
    // Validate envelope against live state (all 9 structural checks)
    const validation = validateEnvelope(state, envelope);

    if (!validation.ok) {
      await appendAuditEvent(artifact_dir, {
        event_type: "mutation_rejected",
        run_id: state.run_id,
        step_cursor: state.step_cursor,
        operator: "mcp",
        operation: "loop_continue_confirmed",
        approval_fingerprint: envelope.fingerprint,
        result: "rejected",
        rejection_reason: `${validation.failure.check}: ${validation.failure.reason}`,
      });

      return {
        ok: false,
        rejection: {
          check: validation.failure.check,
          reason: validation.failure.reason,
          ...(validation.failure.expected !== undefined && { expected: validation.failure.expected }),
          ...(validation.failure.actual !== undefined && { actual: validation.failure.actual }),
        },
      };
    }

    // Validation passed — record mutation_requested
    await appendAuditEvent(artifact_dir, {
      event_type: "mutation_requested",
      run_id: state.run_id,
      step_cursor: state.step_cursor,
      operator: "mcp",
      operation: "loop_continue_confirmed",
      approval_fingerprint: envelope.fingerprint,
      result: "ok",
    });

    // Delegate checkpoint, active_child lease write, and mutation_approved audit to
    // the confirmed continuation service.
    const adapterOverride =
      typeof args["adapterOverride"] === "string"
        ? (args["adapterOverride"] as ExecutionAdapterMode)
        : undefined;
    const dispatchResult = await dispatchConfirmedContinuation({ artifact_dir, envelope, adapterOverride });

    if (!dispatchResult.ok) {
      return { ok: false, rejection: dispatchResult.rejection };
    }

    return {
      ok: true,
      child_id: dispatchResult.child_id,
      compact_return: dispatchResult.compact_return,
    };
  } finally {
    pendingConfirmations.delete(artifact_dir);
  }
}
