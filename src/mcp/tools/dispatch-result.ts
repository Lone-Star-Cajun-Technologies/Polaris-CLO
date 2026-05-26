import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface DispatchResultArgs {
  artifact_dir?: unknown;
  child_id?: unknown;
  status?: unknown;
  commit?: unknown;
  validation?: unknown;
}

const terminalStatuses = new Set(["done", "complete", "completed", "success", "passed"]);

function parseArgs(args: DispatchResultArgs): {
  artifactDir: string;
  childId: string;
  status: string;
  commit?: string;
  validation: unknown;
} {
  const artifactDir = args.artifact_dir ?? "polaris-run";

  if (typeof artifactDir !== "string" || !/^[\w][\w.-]*$/.test(artifactDir)) {
    throw new Error("artifact_dir must be a safe artifact directory name");
  }

  if (typeof args.child_id !== "string" || args.child_id.trim() === "") {
    throw new Error("child_id must be a non-empty string");
  }

  if (typeof args.status !== "string" || args.status.trim() === "") {
    throw new Error("status must be a non-empty string");
  }

  if (args.commit !== undefined && typeof args.commit !== "string") {
    throw new Error("commit must be a string when provided");
  }

  const normalizedChildId = args.child_id.trim();
  const normalizedStatus = args.status.trim();

  return {
    artifactDir,
    childId: normalizedChildId,
    status: normalizedStatus,
    commit: args.commit,
    validation: args.validation ?? null,
  };
}

function statePathFor(artifactDir: string): string {
  return join(process.cwd(), ".taskchain_artifacts", artifactDir, "current-state.json");
}

function telemetryPathFor(artifactDir: string, runId: string): string {
  return join(process.cwd(), ".taskchain_artifacts", artifactDir, "runs", runId, "telemetry.jsonl");
}

function writeJsonAtomic(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function appendTelemetry(
  artifactDir: string,
  runId: string,
  result: { childId: string; status: string; commit?: string; validation: unknown },
): void {
  const event = {
    event: "mcp-dispatch-result",
    run_id: runId,
    child_id: result.childId,
    status: result.status,
    commit: result.commit ?? null,
    validation: result.validation,
    timestamp: new Date().toISOString(),
  };
  const telemetryPath = telemetryPathFor(artifactDir, runId);
  mkdirSync(dirname(telemetryPath), { recursive: true });
  appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
}

function withoutChild(values: unknown, childId: string): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string" && value !== childId);
}

function withCompletedChild(values: unknown, childId: string): string[] {
  const completed = Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
  return completed.includes(childId) ? completed : [...completed, childId];
}

function updateChildMeta(state: Record<string, unknown>, childId: string, status: string): Record<string, unknown> | undefined {
  const meta = state["open_children_meta"];
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const child = (meta as Record<string, unknown>)[childId];
  if (typeof child !== "object" || child === null || Array.isArray(child)) return meta as Record<string, unknown>;
  return {
    ...(meta as Record<string, unknown>),
    [childId]: {
      ...(child as Record<string, unknown>),
      status,
    },
  };
}

export async function handlePolarisDispatchResult(
  args: DispatchResultArgs,
): Promise<Record<string, unknown>> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return {
      ok: false,
      error: "invalid_argument",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const statePath = statePathFor(parsed.artifactDir);
  let state: Record<string, unknown>;
  try {
    state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: "state_not_found",
      message: `State file not found or invalid: .taskchain_artifacts/${parsed.artifactDir}/current-state.json`,
    };
  }

  if (state["active_child"] !== parsed.childId) {
    return {
      ok: false,
      error: "active_child_mismatch",
      expected: state["active_child"] ?? null,
      actual: parsed.childId,
    };
  }

  // Validate run_id strictly before any persistence
  if (typeof state["run_id"] !== "string" || state["run_id"].trim() === "") {
    return {
      ok: false,
      error: "invalid_run_id",
      message: "run_id must be a non-empty string in state",
    };
  }
  const runId = state["run_id"].trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId)) {
    return {
      ok: false,
      error: "invalid_run_id",
      message: "run_id must be a valid UUID format",
    };
  }

  const recordedAt = new Date().toISOString();
  const completed = terminalStatuses.has(parsed.status.toLowerCase());
  const openChildren = completed ? withoutChild(state["open_children"], parsed.childId) : state["open_children"];
  const childMeta = completed ? updateChildMeta(state, parsed.childId, "Done") : updateChildMeta(state, parsed.childId, parsed.status);
  const workerResult = {
    child_id: parsed.childId,
    status: parsed.status,
    commit: parsed.commit ?? null,
    validation: parsed.validation,
    recorded_at: recordedAt,
  };
  const updated = {
    ...state,
    active_child: completed ? null : parsed.childId,
    completed_children: completed
      ? withCompletedChild(state["completed_children"], parsed.childId)
      : state["completed_children"],
    open_children: openChildren,
    ...(Array.isArray(openChildren) ? { next_open_child: openChildren[0] ?? null } : {}),
    ...(childMeta ? { open_children_meta: childMeta } : {}),
    ...(parsed.commit ? { last_commit: parsed.commit } : {}),
    validation_status: parsed.status,
    last_worker_result: workerResult,
    updated_at: recordedAt,
  };

  try {
    writeJsonAtomic(statePath, updated);
    appendTelemetry(parsed.artifactDir, runId, {
      childId: parsed.childId,
      status: parsed.status,
      commit: parsed.commit,
      validation: parsed.validation,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : "Error",
        meta: {
          statePath,
          childId: parsed.childId,
        },
      },
    };
  }

  return {
    ok: true,
    child_id: parsed.childId,
    active_child: updated.active_child,
    recorded: workerResult,
  };
}
