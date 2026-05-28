import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { getMonotonicTimestamp } from "../utils/monotonic-timestamp.js";
import type { RunBootstrapSeal } from "./run-bootstrap.js";

export interface BlockerRecord {
  reason: string;
  child_id: string;
  timestamp: string;
  resolved: boolean;
}

/**
 * Dispatch boundary tracking record.
 *
 * Tracks the epoch counters used to enforce the hard dispatch boundary.
 * The invariant is: dispatch_epoch > continue_epoch means a dispatch was
 * called and has not yet been matched by a polaris loop continue call.
 *
 * These counters are monotonically increasing; they are never reset.
 */
export interface DispatchBoundaryRecord {
  /** Incremented by every `polaris loop dispatch` (or parent-loop dispatch). */
  dispatch_epoch: number;
  /** Incremented by every `polaris loop continue` after successful dispatch. */
  continue_epoch: number;
  /** The child ID that was most recently dispatched. */
  last_dispatched_child: string | null;
}

export interface ChildResultSummary {
  status: "done" | "failed" | "blocked" | "error";
  validation: "passed" | "failed" | "skipped";
  commit: string | null;
  next_recommended_action: "continue" | "stop" | "investigate";
  result_data?: Record<string, unknown>;
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
  completed_children_results?: Record<string, ChildResultSummary>;
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
  /**
   * Dispatch boundary tracking.
   *
   * When present, this record enforces the hard constraint that
   * `polaris loop continue` may only be called after `polaris loop dispatch`.
   * States written before this field was introduced (legacy) do not have it;
   * they fall back to step_cursor-based heuristics.
   */
  dispatch_boundary?: DispatchBoundaryRecord;
  /**
   * Bootstrap seal — proof that this run state was created by the runtime
   * via `polaris loop bootstrap`, not hand-crafted by a parent session.
   *
   * Required before any `polaris loop dispatch` or `polaris loop run` call.
   * Absent from states created before this feature; those states are refused
   * by dispatch with a hard error directing the operator to re-bootstrap.
   */
  run_bootstrap_seal?: RunBootstrapSeal;
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

  // Validate completed_children_results if present
  if ("completed_children_results" in s && s["completed_children_results"] !== undefined) {
    if (typeof s["completed_children_results"] !== "object" || s["completed_children_results"] === null || Array.isArray(s["completed_children_results"])) {
      errors.push("completed_children_results must be an object");
    } else {
      const results = s["completed_children_results"] as Record<string, unknown>;
      for (const [childId, value] of Object.entries(results)) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          errors.push(`completed_children_results["${childId}"] must be an object`);
          continue;
        }
        const childResult = value as Record<string, unknown>;
        if (typeof childResult["status"] !== "string" || !["done", "failed", "blocked", "error"].includes(childResult["status"] as string)) errors.push(`completed_children_results["${childId}"].status must be "done", "failed", "blocked", or "error"`);
        if (typeof childResult["validation"] !== "string" || !["passed", "failed", "skipped"].includes(childResult["validation"] as string)) errors.push(`completed_children_results["${childId}"].validation must be "passed", "failed", or "skipped"`);
        if (childResult["commit"] !== null && typeof childResult["commit"] !== "string") errors.push(`completed_children_results["${childId}"].commit must be a string or null`);
        if (typeof childResult["next_recommended_action"] !== "string" || !["continue", "stop", "investigate"].includes(childResult["next_recommended_action"] as string)) errors.push(`completed_children_results["${childId}"].next_recommended_action must be "continue", "stop", or "investigate"`);
        if ("result_data" in childResult && childResult["result_data"] !== undefined) {
          if (typeof childResult["result_data"] !== "object" || childResult["result_data"] === null || Array.isArray(childResult["result_data"])) {
            errors.push(`completed_children_results["${childId}"].result_data must be an object`);
          }
        }
      }
    }
  }

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

  // Validate run_bootstrap_seal if present
  if ("run_bootstrap_seal" in s && s["run_bootstrap_seal"] !== undefined) {
    if (typeof s["run_bootstrap_seal"] !== "object" || s["run_bootstrap_seal"] === null || Array.isArray(s["run_bootstrap_seal"])) {
      errors.push("run_bootstrap_seal must be an object");
    } else {
      const seal = s["run_bootstrap_seal"] as Record<string, unknown>;
      if (seal["sealer"] !== "polaris-loop-bootstrap") {
        errors.push(`run_bootstrap_seal.sealer must be "polaris-loop-bootstrap"`);
      }
      if (typeof seal["run_id"] !== "string" || !seal["run_id"]) {
        errors.push("run_bootstrap_seal.run_id must be a non-empty string");
      }
      if (typeof seal["cluster_id"] !== "string" || !seal["cluster_id"]) {
        errors.push("run_bootstrap_seal.cluster_id must be a non-empty string");
      }
      if (typeof seal["open_children_sha"] !== "string") {
        errors.push("run_bootstrap_seal.open_children_sha must be a string");
      }
      if (typeof seal["sealed_at"] !== "string") {
        errors.push("run_bootstrap_seal.sealed_at must be a string");
      }
    }
  }

  // Validate dispatch_boundary if present
  if ("dispatch_boundary" in s && s["dispatch_boundary"] !== undefined) {
    if (typeof s["dispatch_boundary"] !== "object" || s["dispatch_boundary"] === null || Array.isArray(s["dispatch_boundary"])) {
      errors.push("dispatch_boundary must be an object");
    } else {
      const db = s["dispatch_boundary"] as Record<string, unknown>;
      if (typeof db["dispatch_epoch"] !== "number" || !Number.isInteger(db["dispatch_epoch"]) || (db["dispatch_epoch"] as number) < 0) {
        errors.push("dispatch_boundary.dispatch_epoch must be a non-negative integer");
      }
      if (typeof db["continue_epoch"] !== "number" || !Number.isInteger(db["continue_epoch"]) || (db["continue_epoch"] as number) < 0) {
        errors.push("dispatch_boundary.continue_epoch must be a non-negative integer");
      }
      if (db["dispatch_epoch"] !== undefined && db["continue_epoch"] !== undefined) {
        if ((db["dispatch_epoch"] as number) < (db["continue_epoch"] as number)) {
          errors.push("dispatch_boundary.dispatch_epoch must be >= continue_epoch");
        }
      }
      if (db["last_dispatched_child"] !== null && typeof db["last_dispatched_child"] !== "string") {
        errors.push("dispatch_boundary.last_dispatched_child must be a string or null");
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
  const timestampedEvent = { ...event, timestamp: getMonotonicTimestamp() };
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(timestampedEvent) + "\n", "utf-8");
}

export function appendBoundaryEvent(
  telemetryFile: string,
  event: BoundaryEvent,
): void {
  const timestampedEvent = { ...event, timestamp: getMonotonicTimestamp() };
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(timestampedEvent) + "\n", "utf-8");
}

export interface AbortEvent {
  event: "loop-aborted";
  run_id: string;
  child_id: string;
  reason: string;
  timestamp: string;
}

export function appendAbortEvent(telemetryFile: string, event: AbortEvent): void {
  const timestampedEvent = { ...event, timestamp: getMonotonicTimestamp() };
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(timestampedEvent) + "\n", "utf-8");
}
