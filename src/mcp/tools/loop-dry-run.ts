import { z } from "zod";
import { loadState } from "../../loop/state.js";
import { computeStateFingerprint, selectNextChild } from "../../loop/verify.js";
import { appendAuditEvent } from "../../loop/audit.js";

export const DryRunInputSchema = z.object({
  run_id: z.string(),
  expected_step_cursor: z.string(),
});

export type DryRunInput = z.infer<typeof DryRunInputSchema>;

export async function handleLoopContinueDryRun(input: DryRunInput): Promise<unknown> {
  const state = await loadState(input.run_id);

  if (state === null) {
    return {
      ok: false,
      rejection: { reason: "run_not_found", detail: `No run found with id: ${input.run_id}` },
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
      rejection: {
        reason: "concurrent_execution",
        detail: `active_child is already set: ${activeChild}`,
      },
    };
  }

  if (state.step_cursor !== input.expected_step_cursor) {
    return {
      ok: false,
      rejection: {
        reason: "step_cursor_mismatch",
        expected: input.expected_step_cursor,
        actual: state.step_cursor,
      },
    };
  }

  const nextChild = selectNextChild(state);
  if (nextChild === null) {
    return { ok: false, rejection: { reason: "no_open_children" } };
  }

  const stateFingerprint = computeStateFingerprint(state);

  await appendAuditEvent(input.run_id, {
    event_type: "dry_run_executed",
    run_id: input.run_id,
    step_cursor: state.step_cursor,
    operator: "mcp",
    operation: "loop_continue_dry_run",
    child_id: nextChild,
    result: "preview",
  });

  return {
    ok: true,
    preview: {
      next_child: nextChild,
      worker_type: "claude-code",
      provider: "claude",
      bootstrap_packet_preview: {
        issue_id: nextChild,
        branch: `claude/${nextChild.toLowerCase()}-continuation`,
        estimated_actions: [
          "checkout worktree",
          "load bootstrap packet",
          "dispatch worker",
        ],
      },
    },
    state_fingerprint: stateFingerprint,
    approval_template: {
      run_id: input.run_id,
      expected_step_cursor: state.step_cursor,
      expected_next_child: nextChild,
      state_fingerprint: stateFingerprint,
    },
  };
}
