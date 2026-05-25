import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CurrentState } from "../types/runtime-state.js";
import { appendAuditEvent } from "./audit/logger.js";
import { getArtifactDir, loadState } from "./state.js";

// Recovery state classifications for interrupted operations:
//
// "interrupted-before-dispatch"
//   Condition: active_child is set in state, but no worker_dispatched event exists in audit log.
//   Resolution: Clear active_child and retry the dispatch from the top of the continue flow.
//
// "dispatched-awaiting-result"
//   Condition: A worker_dispatched audit event exists, but no worker_result_received event follows.
//   Resolution: Check for a worker result (poll or query the provider); do not re-dispatch until confirmed absent.
//
// "partial-commit"
//   Condition: A commit was started (step_completed event exists), but no commit hash recorded in checkpoint.
//   Resolution: Check git status / git log for the expected commit before attempting to re-commit.
//
// "linear-update-failed"
//   Condition: Commit succeeded and hash is present, but no Linear status-Done event in audit log.
//   Resolution: Read current Linear issue status; retry the Linear update idempotently if not already Done.

export type RecoveryState =
  | "interrupted-before-dispatch"
  | "dispatched-awaiting-result"
  | "partial-commit"
  | "linear-update-failed";

// Idempotency requirements:
//
// Worker dispatch: Before dispatching, check the audit log for a prior worker_dispatched event
//   with the same run_id + step_cursor. Do not dispatch a second time if one exists.
//
// git commit: Before re-committing, inspect `git log --oneline -1` for a commit message containing
//   the [child_id] tag. If found, the commit already succeeded — skip the commit step.
//
// Linear status update: Read the current Linear issue status before issuing a Done transition.
//   If the issue is already Done, skip the update to avoid duplicate webhooks or API errors.

export interface CheckpointRecord {
  /** Artifact directory name (e.g. "bootstrap-run") */
  artifact_dir: string;
  /** The step_cursor value at checkpoint time */
  step_cursor: string;
  /** ISO 8601 timestamp when the checkpoint was written */
  written_at: string;
  /** Full snapshot of CurrentState at checkpoint time */
  state_snapshot: CurrentState;
}

function getCheckpointsDir(artifactDir: string): string {
  return path.join(getArtifactDir(artifactDir), "checkpoints");
}

function buildCheckpointFilename(stepCursor: string, timestamp: string): string {
  // Sanitize step_cursor so it can safely appear in a filename
  const safeCursor = stepCursor.replace(/[^a-zA-Z0-9_-]/g, "_");
  // Collapse ISO timestamp to a filesystem-safe form: 20260525T202317Z
  const safeTs = timestamp.replace(/[:.]/g, "").replace("Z", "Z").slice(0, 16) + "Z";
  return `${safeCursor}-${safeTs}.json`;
}

/**
 * Write a checkpoint for the current state of the given artifact directory.
 *
 * Loads the current state snapshot from disk (fresh read), writes it to
 * `.taskchain_artifacts/{artifactDir}/checkpoints/{step_cursor}-{timestamp}.json`,
 * and appends a `checkpoint_written` audit event.
 *
 * Throws if the state file cannot be read or the checkpoint cannot be written.
 */
export async function writeCheckpoint(
  artifactDir: string,
  stepCursor: string,
): Promise<CheckpointRecord> {
  const state = await loadState(artifactDir);
  if (state === null) {
    throw new Error(
      `writeCheckpoint: cannot load state for artifact_dir="${artifactDir}" — current-state.json not found`,
    );
  }

  const writtenAt = new Date().toISOString();
  const filename = buildCheckpointFilename(stepCursor, writtenAt);
  const checkpointsDir = getCheckpointsDir(artifactDir);
  const checkpointPath = path.join(checkpointsDir, filename);

  const record: CheckpointRecord = {
    artifact_dir: artifactDir,
    step_cursor: stepCursor,
    written_at: writtenAt,
    state_snapshot: state,
  };

  await mkdir(checkpointsDir, { recursive: true });
  await writeFile(checkpointPath, JSON.stringify(record, null, 2) + "\n", "utf-8");

  await appendAuditEvent(artifactDir, {
    event_type: "checkpoint_written",
    run_id: state.run_id,
    step_cursor: stepCursor,
    operator: "polaris-runtime",
    operation: "write_checkpoint",
    result: "ok",
    metadata: { checkpoint_file: filename },
  });

  return record;
}

/**
 * Find and return the latest checkpoint for the given artifact directory.
 *
 * Checkpoints are sorted lexicographically by filename; the last entry is the
 * most recent. Returns null if the checkpoints directory does not exist or
 * contains no `.json` files.
 */
export async function recoverFromCheckpoint(
  artifactDir: string,
): Promise<CheckpointRecord | null> {
  const checkpointsDir = getCheckpointsDir(artifactDir);

  let entries: string[];
  try {
    const dirEntries = await readdir(checkpointsDir);
    entries = dirEntries.filter((name) => name.endsWith(".json")).sort();
  } catch {
    // Directory does not exist or is not readable — no checkpoints
    return null;
  }

  if (entries.length === 0) {
    return null;
  }

  const latestFile = entries[entries.length - 1]!;
  const filePath = path.join(checkpointsDir, latestFile);

  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as CheckpointRecord;
  } catch {
    return null;
  }
}
