import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { readState, validateState, writeStateAtomic, type LoopState } from "./checkpoint.js";
import { compileImplPacket, type WorkerPacket } from "./worker-packet.js";
import { selectPromptMode } from "./worker-prompt.js";
import {
  advanceDispatchEpoch,
  assertNoActiveChildBeforeDispatch,
} from "./dispatch-boundary.js";
import { assertBootstrapSeal } from "./run-bootstrap.js";

export interface DispatchOptions {
  stateFile: string;
  repoRoot: string;
  childId?: string;
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

function resolveTelemetryFile(state: LoopState, repoRoot: string): string {
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  return join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function getCurrentBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return (process.env["POLARIS_BRANCH"] as string | undefined) ?? "unknown";
  }
}

function selectChild(state: LoopState, requestedChild?: string): string {
  // Note: active_child check now handled by assertNoActiveChildBeforeDispatch
  // before this function is called
  if (state.status === "blocked") {
    fail("current-state.json status is blocked");
  }
  if (state.status === "cluster-complete") {
    fail("current-state.json status is cluster-complete");
  }
  if (state.open_children.length === 0) {
    fail("no open children exist");
  }
  if (requestedChild) {
    if (!state.open_children.includes(requestedChild)) {
      fail(`child ${requestedChild} is not open`);
    }
    return requestedChild;
  }
  return state.open_children[0];
}

function buildPacket(
  state: LoopState,
  childId: string,
  stateFile: string,
  telemetryFile: string,
  repoRoot: string,
): WorkerPacket {
  const childMeta = state.open_children_meta?.[childId];
  const issueContext = childMeta
    ? {
        id: childId,
        title: childMeta.title ?? childId,
        key_requirements: [],
      }
    : undefined;

  return compileImplPacket({
    runId: state.run_id,
    clusterId: state.cluster_id,
    childId,
    branch: state.branch ?? getCurrentBranch(repoRoot),
    stateFile: canonicalPath(stateFile),
    telemetryFile,
    issueContext,
    maxConcurrentWorkers: 1,
    promptMode: selectPromptMode(childId, state),
  });
}

export function runLoopDispatch(options: DispatchOptions): void {
  let state: LoopState;
  try {
    const rawState = readState(options.stateFile);
    const errors = validateState(rawState);
    if (errors.length > 0) {
      fail(`current-state.json is invalid:\n${errors.join("\n")}`);
    }
    state = rawState;
  } catch (err) {
    fail(
      `cannot read state file ${options.stateFile}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const telemetryFile = resolveTelemetryFile(state, options.repoRoot);

  // ── Bootstrap seal enforcement ─────────────────────────────────────────────
  // The run MUST have been initialized through `polaris loop bootstrap`.
  // Hand-crafted state (no seal) is refused before any child is dispatched.
  try {
    assertBootstrapSeal(state, telemetryFile);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // ── Dispatch boundary enforcement ─────────────────────────────────────────
  // Halt immediately if active_child is already set (orphaned dispatch).
  // The parent/orchestrator MUST NOT re-dispatch or complete inline.
  try {
    assertNoActiveChildBeforeDispatch(state, telemetryFile);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const childId = selectChild(state, options.childId);

  const updatedState: LoopState = {
    ...state,
    active_child: childId,
    next_open_child: childId,
    step_cursor: "dispatch",
    dispatch_boundary: advanceDispatchEpoch(state.dispatch_boundary, childId),
  };
  writeStateAtomic(options.stateFile, updatedState);

  const packet = buildPacket(
    updatedState,
    childId,
    options.stateFile,
    telemetryFile,
    options.repoRoot,
  );

  appendTelemetry(telemetryFile, {
    event: "child-dispatched",
    run_id: updatedState.run_id,
    child_id: childId,
    prompt_mode: packet.prompt_mode,
    prompt_estimated_tokens: packet.prompt_metrics.estimated_tokens,
    timestamp: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}
