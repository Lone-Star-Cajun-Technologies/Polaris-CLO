import { join } from "node:path";
import {
  readState,
  validateState,
  writeStateAtomic,
  appendAbortEvent,
} from "./checkpoint.js";

export interface AbortOptions {
  reason: string;
  childId?: string;
  stateFile?: string;
  repoRoot: string;
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
