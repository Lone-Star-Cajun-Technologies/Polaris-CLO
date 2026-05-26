import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

export interface BlockerRecord {
  reason: string;
  child_id: string;
  timestamp: string;
  resolved: boolean;
}

export interface LoopState {
  schema_version: string;
  run_id: string;
  cluster_id: string;
  skill?: string;
  /** Git branch this run is executing on. */
  branch?: string;
  session_type?: "analyze" | "implement" | string;
  active_child: string;
  completed_children: string[];
  open_children: string[];
  open_children_meta?: Record<string, { type?: string; title?: string; labels?: string[] }>;
  step_cursor: string | null;
  context_budget: {
    children_completed: number;
    files_touched_total?: number;
    max_children_per_session?: number;
  };
  status: string;
  last_commit?: string;
  next_open_child: string | null;
  artifact_dir?: string;
  blocker?: BlockerRecord;
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
  if (s["step_cursor"] !== null && typeof s["step_cursor"] !== "string") errors.push("missing step_cursor");
  if (typeof s["context_budget"] !== "object" || s["context_budget"] === null) {
    errors.push("missing context_budget");
  } else {
    const budget = s["context_budget"] as Record<string, unknown>;
    if (typeof budget["children_completed"] !== "number" || !isFinite(budget["children_completed"] as number))
      errors.push("missing or invalid context_budget.children_completed");
  }
  if (typeof s["status"] !== "string") errors.push("missing status");

  // Validate open_children_meta if present
  if ("open_children_meta" in s && s["open_children_meta"] !== undefined) {
    if (typeof s["open_children_meta"] !== "object" || s["open_children_meta"] === null || Array.isArray(s["open_children_meta"])) {
      errors.push("open_children_meta must be an object");
    } else {
      const meta = s["open_children_meta"] as Record<string, unknown>;
      for (const [childId, value] of Object.entries(meta)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          errors.push(`open_children_meta["${childId}"] must be an object`);
          continue;
        }
        const childMeta = value as Record<string, unknown>;
        if ("type" in childMeta && childMeta["type"] !== undefined && typeof childMeta["type"] !== "string") {
          errors.push(`open_children_meta["${childId}"].type must be a string`);
        }
        if ("title" in childMeta && childMeta["title"] !== undefined && typeof childMeta["title"] !== "string") {
          errors.push(`open_children_meta["${childId}"].title must be a string`);
        }
        if ("labels" in childMeta && childMeta["labels"] !== undefined) {
          if (!Array.isArray(childMeta["labels"]) || !childMeta["labels"].every((l: unknown) => typeof l === "string")) {
            errors.push(`open_children_meta["${childId}"].labels must be an array of strings`);
          }
        }
      }
    }
  }

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

export interface BoundaryEvent {
  event: "analyze-impl-boundary-enforced";
  run_id: string;
  stopped_before: string | null;
  reason: string;
  timestamp: string;
}

export function appendCheckpointEvent(
  telemetryFile: string,
  event: CheckpointEvent,
): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

export function appendBoundaryEvent(
  telemetryFile: string,
  event: BoundaryEvent,
): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

export interface AbortEvent {
  event: "loop-aborted";
  run_id: string;
  child_id: string;
  reason: string;
  timestamp: string;
}

export function appendAbortEvent(telemetryFile: string, event: AbortEvent): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}
