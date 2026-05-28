import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readState,
  validateState,
  writeStateAtomic,
  appendAbortEvent,
  type LoopState,
} from "./checkpoint.js";
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

  const childId = options.childId ?? state.active_child ?? "";
  const timestamp = new Date().toISOString();

  const updatedState = {
    ...state,
    status: "blocked",
    blocker: {
      reason,
      child_id: childId,
      timestamp,
      resolved: false,
    },
  };

  writeStateAtomic(stateFile, updatedState);
  appendBlockedLedgerEvent(repoRoot, updatedState, childId, reason);

  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");

  appendAbortEvent(telemetryFile, {
    event: "loop-aborted",
    run_id: state.run_id,
    child_id: childId,
    reason,
    timestamp,
  });

  process.stderr.write(
    `Loop aborted. Reason: ${reason}. Resolve blocker then run: polaris loop resume\n`,
  );
  process.exit(1);
}
