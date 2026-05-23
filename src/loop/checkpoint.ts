import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export interface LoopState {
  schema_version: string;
  run_id: string;
  cluster_id: string;
  skill?: string;
  active_child: string;
  completed_children: string[];
  open_children: string[];
  step_cursor: string;
  context_budget: {
    children_completed: number;
    files_touched_total?: number;
    max_children_per_session?: number;
  };
  status: string;
  last_commit?: string;
  next_open_child: string | null;
  artifact_dir?: string;
}

export interface CheckpointEvent {
  event: "loop-checkpoint";
  run_id: string;
  child_id: string;
  next_child: string | null;
  timestamp: string;
}

export function readState(stateFile: string): LoopState {
  const raw = readFileSync(stateFile, "utf-8");
  return JSON.parse(raw) as LoopState;
}

export function validateState(state: unknown): string[] {
  const errors: string[] = [];
  if (typeof state !== "object" || state === null) {
    return ["current-state.json must be a JSON object"];
  }
  const s = state as Record<string, unknown>;
  if (typeof s["schema_version"] !== "string") errors.push("missing schema_version");
  if (typeof s["run_id"] !== "string" || !s["run_id"]) errors.push("missing run_id");
  if (typeof s["cluster_id"] !== "string" || !s["cluster_id"]) errors.push("missing cluster_id");
  if (typeof s["active_child"] !== "string") errors.push("missing active_child");
  if (!Array.isArray(s["completed_children"])) errors.push("completed_children must be an array");
  if (!Array.isArray(s["open_children"])) errors.push("open_children must be an array");
  if (typeof s["step_cursor"] !== "string") errors.push("missing step_cursor");
  if (typeof s["context_budget"] !== "object" || s["context_budget"] === null)
    errors.push("missing context_budget");
  if (typeof s["status"] !== "string") errors.push("missing status");
  return errors;
}

export function writeStateAtomic(stateFile: string, state: LoopState): string {
  const content = JSON.stringify(state, null, 2);
  const tmp = `${stateFile}.tmp`;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, stateFile);
  return createHash("sha256").update(content).digest("hex");
}

export function appendCheckpointEvent(
  telemetryFile: string,
  event: CheckpointEvent,
): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}
