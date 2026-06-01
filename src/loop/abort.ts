import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readState,
  validateState,
  writeStateAtomic,
  appendAbortEvent,
  appendStaleDispatchAbortedEvent,
  type LoopState,
} from "./checkpoint.js";
import { getMachineState } from "./dispatch-boundary.js";
import {
  DEFAULT_LEDGER_PATH,
  LedgerWriter,
  type LedgerRunType,
  type RunBlockedEvent,
} from "./ledger.js";

export interface AbortOptions {
  reason: string;
  childId?: string;
  stateFile?: string;
  repoRoot: string;
}

function normalizeRunType(sessionType: string | undefined): LedgerRunType {
  return sessionType === "analyze" ? "analyze" : "implement";
}

function ledgerLastCommit(state: LoopState): string | null {
  return state.last_commit && state.last_commit.length > 0 ? state.last_commit : null;
}

function appendBlockedLedgerEvent(repoRoot: string, state: LoopState, childId: string, reason: string): void {
  new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH)).append({
    schema_version: 1,
    event_id: randomUUID(),
    event: "run-blocked",
    run_id: state.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id,
    issue_id: childId || null,
    branch: state.branch ?? "unknown",
    status: "blocked",
    completed_children: state.completed_children,
    open_children: state.open_children,
    next_child: state.next_open_child,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp: new Date().toISOString(),
    blocker: {
      summary: reason,
      unblock_condition: "Resolve blocker then run: polaris loop resume",
    },
  } satisfies RunBlockedEvent);
}

interface StaleDispatchInfo {
  isStale: boolean;
  hasHeartbeat: boolean;
  hasResultFile: boolean;
  abortedDispatchId?: string;
}

/**
 * Detect whether the current state has a stuck dispatch with no worker activity.
 * A dispatch is considered stale when active_child is set, the machine state is
 * "dispatched", but the worker has no heartbeat and the expected result file is absent.
 * This covers both the "packet-created" runtime state and older delegated dispatches
 * that never progressed.
 */
function detectStaleDispatch(state: LoopState, repoRoot: string): StaleDispatchInfo {
  if (!state.active_child || state.active_child === "") {
    return { isStale: false, hasHeartbeat: false, hasResultFile: false };
  }

  if (getMachineState(state) !== "dispatched") {
    return { isStale: false, hasHeartbeat: false, hasResultFile: false };
  }

  const dr = state.open_children_meta?.[state.active_child]?.dispatch_record;

  const hasHeartbeat = !!(dr?.last_heartbeat_at);

  let hasResultFile = false;
  if (dr?.expected_result_path) {
    const resultPath = isAbsolute(dr.expected_result_path)
      ? dr.expected_result_path
      : join(repoRoot, dr.expected_result_path);
    hasResultFile = existsSync(resultPath);
  }

  // Only treat as stale when the worker left no evidence at all.
  // If a heartbeat exists the worker may still be running; if a result file
  // exists the worker completed and its output must be handled before clearing.
  // In either case the operator must resolve the situation manually.
  return {
    isStale: !hasHeartbeat && !hasResultFile,
    hasHeartbeat,
    hasResultFile,
    abortedDispatchId: dr?.dispatch_id,
  };
}

export function runLoopAbort(options: AbortOptions): void {
  const { reason, repoRoot } = options;
  const stateFile =
    options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");

  let state: ReturnType<typeof readState>;
  try {
    const raw = readState(stateFile);
    const errors = validateState(raw);
    if (errors.length > 0) {
      process.stderr.write(`current-state.json invalid:\n${errors.join("\n")}\n`);
      process.exit(1);
    }
    state = raw;
  } catch (err) {
    process.stderr.write(
      `Error: cannot read state file ${stateFile}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const staleInfo = detectStaleDispatch(state, repoRoot);

  let updatedState: LoopState;
  let effectiveChildId: string;

  if (staleInfo.isStale) {
    // Stale dispatch: clear active_child, balance dispatch_boundary epochs, and
    // mark the old dispatch record as failed so fresh dispatch can proceed after
    // the operator runs `polaris loop resume` to exit the blocked state.
    const stuckChildId = state.active_child;
    effectiveChildId = options.childId ?? stuckChildId ?? "";

    const existingMeta = state.open_children_meta ?? {};
    const childMeta = existingMeta[stuckChildId] ?? {};
    const oldDr = childMeta.dispatch_record;

    updatedState = {
      ...state,
      active_child: "",
      step_cursor: state.step_cursor === "dispatch" ? null : state.step_cursor,
      dispatch_boundary: state.dispatch_boundary
        ? {
            ...state.dispatch_boundary,
            // Balance epochs so the machine returns to checkpointed/idle,
            // allowing a fresh dispatch once the blocked status is cleared.
            continue_epoch: state.dispatch_boundary.dispatch_epoch,
          }
        : state.dispatch_boundary,
      status: "blocked",
      blocker: {
        reason,
        child_id: effectiveChildId,
        timestamp,
        resolved: false,
      },
      open_children_meta: {
        ...existingMeta,
        [stuckChildId]: {
          ...childMeta,
          ...(oldDr
            ? { dispatch_record: { ...oldDr, status: "failed" as const, runtime_state: "failed" as const } }
            : {}),
        },
      },
    };
  } else {
    effectiveChildId = options.childId ?? state.active_child ?? "";
    updatedState = {
      ...state,
      status: "blocked",
      blocker: {
        reason,
        child_id: effectiveChildId,
        timestamp,
        resolved: false,
      },
    };
  }

  writeStateAtomic(stateFile, updatedState);
  appendBlockedLedgerEvent(repoRoot, updatedState, effectiveChildId, reason);

  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");

  if (staleInfo.isStale) {
    appendStaleDispatchAbortedEvent(telemetryFile, {
      event: "stale-dispatch-aborted",
      run_id: state.run_id,
      child_id: state.active_child,
      reason,
      aborted_dispatch_id: staleInfo.abortedDispatchId,
      had_heartbeat: staleInfo.hasHeartbeat,
      had_result_file: staleInfo.hasResultFile,
      timestamp,
    });
  }

  appendAbortEvent(telemetryFile, {
    event: "loop-aborted",
    run_id: state.run_id,
    child_id: effectiveChildId,
    reason,
    timestamp,
  });

  process.stderr.write(
    `Loop aborted. Reason: ${reason}. Resolve blocker then run: polaris loop resume\n`,
  );
  process.exit(1);
}
