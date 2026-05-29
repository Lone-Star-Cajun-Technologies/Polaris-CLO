import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { readState, validateState, writeStateAtomic, type LoopState, type ChildDispatchRecord } from "./checkpoint.js";
import { compileImplPacket, type WorkerPacket } from "./worker-packet.js";
import { selectPromptMode } from "./worker-prompt.js";
import {
  advanceDispatchEpoch,
  assertNoActiveChildBeforeDispatch,
} from "./dispatch-boundary.js";
import { assertBootstrapSeal } from "./run-bootstrap.js";
import {
  DEFAULT_LEDGER_PATH,
  LedgerWriter,
  type ChildDispatchedEvent,
  type LedgerRunType,
} from "./ledger.js";

export interface DispatchOptions {
  stateFile: string;
  repoRoot: string;
  childId?: string;
  resultFile?: string;
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}
`);
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

function absoluteResultFile(repoRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
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

/**
 * Get cluster-scoped packet directory path.
 * Format: .polaris/clusters/<cluster-id>/packets/
 */
function getClusterPacketDir(repoRoot: string, clusterId: string): string {
  return join(repoRoot, ".polaris", "clusters", clusterId, "packets");
}

/**
 * Get cluster-scoped results directory path.
 * Format: .polaris/clusters/<cluster-id>/results/
 */
function getClusterResultDir(repoRoot: string, clusterId: string): string {
  return join(repoRoot, ".polaris", "clusters", clusterId, "results");
}

/**
 * Build dispatch artifact paths in cluster-scoped layout.
 * Returns packet path and expected result path.
 */
function buildClusterArtifactPaths(
  repoRoot: string,
  clusterId: string,
  childId: string,
  dispatchId: string,
): { packetPath: string; resultPath: string } {
  const packetDir = getClusterPacketDir(repoRoot, clusterId);
  const resultDir = getClusterResultDir(repoRoot, clusterId);
  const filename = `${childId}-${dispatchId}.json`;
  return {
    packetPath: join(packetDir, filename),
    resultPath: join(resultDir, filename),
  };
}

/**
 * Write packet artifact to cluster-scoped layout.
 * Creates directories if needed.
 */
function writePacketArtifact(packetPath: string, packet: WorkerPacket): void {
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf-8");
}

/**
 * Create a dispatch record with all required evidence.
 */
function createDispatchRecord(
  runId: string,
  clusterId: string,
  childId: string,
  packetPath: string,
  resultPath: string,
  provider?: string,
): ChildDispatchRecord {
  return {
    dispatch_id: randomUUID(),
    child_id: childId,
    run_id: runId,
    cluster_id: clusterId,
    packet_path: packetPath,
    expected_result_path: resultPath,
    provider,
    dispatched_at: new Date().toISOString(),
    status: "dispatched",
  };
}

function normalizeRunType(sessionType: string | undefined): LedgerRunType {
  return sessionType === "analyze" ? "analyze" : "implement";
}

function ledgerLastCommit(state: LoopState): string | null {
  return state.last_commit && state.last_commit.length > 0 ? state.last_commit : null;
}

function appendDispatchLedgerEvent(repoRoot: string, state: LoopState, childId: string): void {
  new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH)).append({
    schema_version: 1,
    event_id: randomUUID(),
    event: "child-dispatched",
    run_id: state.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id,
    issue_id: childId,
    branch: state.branch ?? getCurrentBranch(repoRoot),
    status: "child-dispatched",
    completed_children: state.completed_children,
    open_children: state.open_children,
    next_child: childId,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp: new Date().toISOString(),
    dispatch_epoch: state.dispatch_boundary?.dispatch_epoch ?? 0,
  } satisfies ChildDispatchedEvent);
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
  resultFile?: string,
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
    resultFile: resultFile ? canonicalPath(absoluteResultFile(repoRoot, resultFile)) : undefined,
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
    const msg = err instanceof Error ? err.message : String(err);
    const event = {
      event: "invalid-inline-attempt",
      run_id: state.run_id,
      child_id: state.active_child,
      error: msg,
      timestamp: new Date().toISOString(),
    };
    appendTelemetry(telemetryFile, event);
    const defaultTelemetryFile = join(
      options.repoRoot,
      ".taskchain_artifacts",
      "polaris-run",
      "runs",
      state.run_id,
      "telemetry.jsonl",
    );
    if (defaultTelemetryFile !== telemetryFile) {
      appendTelemetry(defaultTelemetryFile, event);
    }
    fail(msg);
  }

  const childId = selectChild(state, options.childId);

  // ── Build packet before writing state ───────────────────────────────────────
  // We need to build the packet first to know its content for the artifact.
  // Use a preliminary state to build the packet (we'll update state after).
  const preliminaryState: LoopState = {
    ...state,
    active_child: childId,
    next_open_child: childId,
    step_cursor: "dispatch",
    dispatch_boundary: advanceDispatchEpoch(state.dispatch_boundary, childId),
  };

  const packet = buildPacket(
    preliminaryState,
    childId,
    options.stateFile,
    telemetryFile,
    options.repoRoot,
    options.resultFile,
  );

  // ── Write durable dispatch evidence ────────────────────────────────────────
  // Create cluster-scoped packet artifact BEFORE updating state.
  // This ensures "dispatched" only means a durable record exists.
  const dispatchId = randomUUID();
  const { packetPath, resultPath } = buildClusterArtifactPaths(
    options.repoRoot,
    state.cluster_id,
    childId,
    dispatchId,
  );

  // Write packet artifact - this MUST succeed before we report dispatch success
  try {
    writePacketArtifact(packetPath, packet);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    // Record the failure in telemetry
    appendTelemetry(telemetryFile, {
      event: "dispatch-failed",
      run_id: state.run_id,
      child_id: childId,
      error: `Failed to write packet artifact: ${errorMsg}`,
      timestamp: new Date().toISOString(),
    });
    fail(`Failed to write packet artifact to ${packetPath}: ${errorMsg}`);
  }

  // Create dispatch record with all evidence
  const dispatchRecord = createDispatchRecord(
    state.run_id,
    state.cluster_id,
    childId,
    packetPath,
    resultPath,
    undefined, // provider not known at this point
  );

  // ── Update state atomically with dispatch record ───────────────────────────
  const updatedState: LoopState = {
    ...preliminaryState,
    // Store the dispatch record in open_children_meta for the child
    open_children_meta: {
      ...state.open_children_meta,
      [childId]: {
        ...state.open_children_meta?.[childId],
        dispatch_record: dispatchRecord,
      },
    },
  };

  writeStateAtomic(options.stateFile, updatedState);
  appendDispatchLedgerEvent(options.repoRoot, updatedState, childId);

  appendTelemetry(telemetryFile, {
    event: "child-dispatched",
    run_id: updatedState.run_id,
    child_id: childId,
    prompt_mode: packet.prompt_mode,
    prompt_estimated_tokens: packet.prompt_metrics.estimated_tokens,
    packet_path: packetPath,
    expected_result_path: resultPath,
    timestamp: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}
