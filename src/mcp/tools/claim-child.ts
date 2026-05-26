import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface ClaimChildArgs {
  artifact_dir?: unknown;
  child_id?: unknown;
}

const pendingClaims = new Set<string>();

function parseArgs(args: ClaimChildArgs): { artifactDir: string; childId: string } {
  const artifactDir = args.artifact_dir ?? "polaris-run";
  const childId = args.child_id;

  if (typeof artifactDir !== "string" || !/^[\w][\w.-]*$/.test(artifactDir)) {
    throw new Error("artifact_dir must be a safe artifact directory name");
  }

  if (typeof childId !== "string" || childId.trim() === "") {
    throw new Error("child_id must be a non-empty string");
  }

  return { artifactDir, childId };
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

function appendTelemetry(artifactDir: string, state: Record<string, unknown>, childId: string): void {
  if (typeof state["run_id"] !== "string") {
    throw new Error("run_id must be a string in state before emitting telemetry");
  }
  const runId = state["run_id"];
  const event = {
    event: "mcp-claim-child",
    run_id: runId,
    child_id: childId,
    timestamp: new Date().toISOString(),
  };
  const telemetryPath = telemetryPathFor(artifactDir, runId);
  mkdirSync(dirname(telemetryPath), { recursive: true });
  appendFileSync(telemetryPath, JSON.stringify(event) + "\n", "utf-8");
}

export async function handlePolarisClaimChild(
  args: ClaimChildArgs,
): Promise<Record<string, unknown>> {
  let parsed: { artifactDir: string; childId: string };
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return {
      ok: false,
      error: "invalid_argument",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const lockKey = parsed.artifactDir;
  if (pendingClaims.has(lockKey)) {
    return {
      ok: false,
      error: "already_claimed",
      message: `A claim is already in progress for artifact_dir=${parsed.artifactDir}`,
    };
  }

  pendingClaims.add(lockKey);
  try {
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

    if (typeof state["active_child"] === "string" && state["active_child"].length > 0) {
      return {
        ok: false,
        error: "already_claimed",
        active_child: state["active_child"],
      };
    }

    const openChildren = Array.isArray(state["open_children"]) ? state["open_children"] : [];
    if (!openChildren.includes(parsed.childId)) {
      return {
        ok: false,
        error: "child_not_open",
        child_id: parsed.childId,
      };
    }

    const updated = {
      ...state,
      active_child: parsed.childId,
      updated_at: new Date().toISOString(),
    };

    try {
      writeJsonAtomic(statePath, updated);
      appendTelemetry(parsed.artifactDir, updated, parsed.childId);
    } catch (error) {
      return {
        ok: false,
        error: "telemetry_write_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return {
      ok: true,
      child_id: parsed.childId,
      active_child: parsed.childId,
    };
  } finally {
    pendingClaims.delete(lockKey);
  }
}
