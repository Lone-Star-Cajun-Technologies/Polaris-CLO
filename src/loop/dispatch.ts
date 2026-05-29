import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, isAbsolute, resolve } from "node:path";
import { readState, validateState, writeStateAtomic, type LoopState, type ChildDispatchRecord, type DispatchMode, type WorkerRuntimeState, type WorkerAssignmentRecord } from "./checkpoint.js";
import { compileImplPacket, type WorkerPacket, type WorkerRoleContext } from "./worker-packet.js";
import { loadConfig } from "../config/loader.js";
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
import type {
  WorkerAssignmentAttemptedEvent,
  WorkerAssignedEvent,
  WorkerAssignmentFailedEvent,
  EscalationInitiatedEvent,
} from "./dispatch-state.js";

export interface DispatchOptions {
  stateFile: string;
  repoRoot: string;
  childId?: string;
  resultFile?: string;
  /** Provider for direct-worker dispatch; if omitted, checks config then falls back to delegated mode */
  provider?: string;
}

/**
 * Resolve provider from config when no explicit --provider flag is set.
 * Returns the first configured provider in rotation, or undefined if none configured.
 */
function resolveConfigProvider(repoRoot: string): string | undefined {
  try {
    const config = loadConfig(repoRoot);
    const exec = config.execution;
    if (!exec) return undefined;
    if (exec.rotation && exec.rotation.length > 0) return exec.rotation[0];
    const keys = Object.keys(exec.providers ?? {});
    if (keys.length > 0) return keys[0];
  } catch {
    // Config not present or invalid — fall through to delegated mode
  }
  return undefined;
}

/**
 * Determine the effective provider and dispatch mode using the 4-scenario decision tree:
 *   1. --provider flag set → direct-worker (no fallback)
 *   2. Provider in .polaris/config → direct-worker (no fallback)
 *   3. Internal subagent available → delegated dispatch with fallback chain
 *   4. Nothing available → pending-escalation (handled in attemptDelegatedAssignment)
 */
function resolveProviderAndMode(
  options: DispatchOptions,
): { provider: string | undefined; mode: DispatchMode } {
  if (options.provider) {
    return { provider: options.provider, mode: "direct-worker" };
  }
  const configProvider = resolveConfigProvider(options.repoRoot);
  if (configProvider) {
    return { provider: configProvider, mode: "direct-worker" };
  }
  return { provider: undefined, mode: "delegated" };
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
 * Determine dispatch mode based on provider presence.
 */
function determineDispatchMode(provider: string | undefined): DispatchMode {
  return provider ? "direct-worker" : "delegated";
}

/**
 * Determine initial runtime state based on dispatch mode.
 */
function determineRuntimeState(mode: DispatchMode): WorkerRuntimeState {
  return mode === "delegated" ? "delegated" : "packet-created";
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
  roleContext?: WorkerRoleContext,
  provider?: string,
): ChildDispatchRecord {
  const dispatchMode = determineDispatchMode(provider);
  const runtimeState = determineRuntimeState(dispatchMode);

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
    dispatch_mode: dispatchMode,
    runtime_state: runtimeState,
    worker_id: randomUUID(),
    session_id: null,
    attachment_capable: false,
    role: roleContext?.role,
    role_authority: roleContext?.role_authority,
    may_implement: roleContext?.may_implement,
    session_type: roleContext ? (
      roleContext.role === 'worker' ? 'implementation' :
      roleContext.role === 'foreman' ? 'coordination' :
      roleContext.role === 'analyst' ? 'analysis' :
      roleContext.role === 'librarian' ? 'documentation' : undefined
    ) : undefined,
  };
}

// ── Subagent spawn interface ───────────────────────────────────────────────
type AgentSubtaskDispatcher = (
  packet: WorkerPacket,
  context: {
    dispatchId: string;
    runId: string;
    childId: string;
    sessionId: string;
  },
) => unknown;

function getSubagentDispatcher(): AgentSubtaskDispatcher | undefined {
  const host = globalThis as typeof globalThis & {
    __POLARIS_AGENT_SUBTASK_DISPATCH__?: AgentSubtaskDispatcher;
  };
  return host.__POLARIS_AGENT_SUBTASK_DISPATCH__;
}

/**
 * Result of a delegated assignment attempt.
 */
interface AssignmentOutcome {
  assignment: WorkerAssignmentRecord;
  session_id: string | null;
  attachment_capable: boolean;
  runtime_state: WorkerRuntimeState;
}

/**
 * Emit a worker-assignment-attempted event (before each spawn attempt).
 */
function emitAssignmentAttempted(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  assignmentType: WorkerAssignmentAttemptedEvent["assignment_type"],
): void {
  appendTelemetry(telemetryFile, {
    event: "worker-assignment-attempted",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    assignment_type: assignmentType,
    timestamp: new Date().toISOString(),
  } satisfies WorkerAssignmentAttemptedEvent);
}

/**
 * Emit a worker-assigned event on success.
 */
function emitAssigned(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  assignmentType: WorkerAssignedEvent["assignment_type"],
  subagentSessionId?: string,
  processPid?: number,
  handoffToken?: string,
): void {
  appendTelemetry(telemetryFile, {
    event: "worker-assigned",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    assignment_type: assignmentType,
    ...(subagentSessionId !== undefined ? { subagent_session_id: subagentSessionId } : {}),
    ...(processPid !== undefined ? { process_pid: processPid } : {}),
    ...(handoffToken !== undefined ? { handoff_token: handoffToken } : {}),
    timestamp: new Date().toISOString(),
  } satisfies WorkerAssignedEvent);
}

/**
 * Emit a worker-assignment-failed event on each mechanism failure.
 */
function emitAssignmentFailed(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  reason: WorkerAssignmentFailedEvent["reason"],
): void {
  appendTelemetry(telemetryFile, {
    event: "worker-assignment-failed",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    reason,
    timestamp: new Date().toISOString(),
  } satisfies WorkerAssignmentFailedEvent);
}

/**
 * Emit an escalation-initiated event when all mechanisms are exhausted.
 */
function emitEscalationInitiated(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  reason: string,
): void {
  appendTelemetry(telemetryFile, {
    event: "escalation-initiated",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    reason,
    recommended_action: "manual-dispatch",
    timestamp: new Date().toISOString(),
  } satisfies EscalationInitiatedEvent);
}

/**
 * Attempt the delegated assignment fallback chain:
 *   1. subagent spawn attempt
 *   2. external-process fallback
 *   3. human-handoff fallback
 *   4. pending-escalation (all mechanisms exhausted)
 *
 * Emits telemetry events at each decision point (before state transitions).
 * Returns the assignment outcome with evidence.
 */
function attemptDelegatedAssignment(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  packet: WorkerPacket,
): AssignmentOutcome {
  const now = new Date().toISOString();

  // Step 1: Try subagent spawn
  emitAssignmentAttempted(telemetryFile, dispatchId, runId, childId, "subagent");
  const dispatcher = getSubagentDispatcher();

  if (dispatcher) {
    // Subagent available - attempt dispatch
    const sessionId = randomUUID();
    try {
      void dispatcher(packet, { dispatchId, runId, childId, sessionId });
      emitAssigned(telemetryFile, dispatchId, runId, childId, "subagent", sessionId);
      return {
        assignment: {
          assigned_at: now,
          assignment_type: "subagent",
          subagent_session_id: sessionId,
        },
        session_id: sessionId,
        attachment_capable: false,
        runtime_state: "delegated",
      };
    } catch (err) {
      // Dispatcher invocation failed, fall through to next mechanism
      const errorMsg = err instanceof Error ? err.message : String(err);
      emitAssignmentFailed(telemetryFile, dispatchId, runId, childId, "no-subagent-support");
      appendTelemetry(telemetryFile, {
        event: "subagent-spawn-error",
        event_id: randomUUID(),
        dispatch_id: dispatchId,
        run_id: runId,
        child_id: childId,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });
      // Continue to external-process fallback below
    }
  } else {
    // Subagent unavailable
    emitAssignmentFailed(telemetryFile, dispatchId, runId, childId, "no-subagent-support");
  }

  // Step 2: Try external-process fallback (not available in this wave)
  emitAssignmentAttempted(telemetryFile, dispatchId, runId, childId, "external-process");
  emitAssignmentFailed(telemetryFile, dispatchId, runId, childId, "provider-unavailable");

  // Step 3: Try human-handoff fallback (not available in this wave)
  emitAssignmentAttempted(telemetryFile, dispatchId, runId, childId, "human-handoff");
  emitAssignmentFailed(telemetryFile, dispatchId, runId, childId, "provider-unavailable");

  // Step 4: All mechanisms exhausted — pending-escalation
  const escalationReason = "No assignment mechanism available: subagent not supported, no external-process or human-handoff configured";
  emitEscalationInitiated(telemetryFile, dispatchId, runId, childId, escalationReason);

  return {
    assignment: {
      assigned_at: now,
      assignment_type: "pending-escalation",
      escalation_reason: escalationReason,
    },
    session_id: null,
    attachment_capable: false,
    runtime_state: "delegated",
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
  // Single-emission guard: check if this invalid-inline condition was already recorded
  const invalidInlineAlreadyRecorded = state.step_cursor === "invalid-inline-attempt";
  try {
    assertNoActiveChildBeforeDispatch(state, telemetryFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only emit telemetry once per invalid-inline condition
    if (!invalidInlineAlreadyRecorded) {
      const event = {
        event: "invalid-inline-attempt",
        run_id: state.run_id,
        child_id: state.active_child,
        reason: msg,
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
    }
    fail(msg);
  }

  const childId = selectChild(state, options.childId);

  // ── Resolve provider and dispatch mode ─────────────────────────────────────
  const { provider: resolvedProvider, mode: resolvedMode } = resolveProviderAndMode(options);

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
    packet.role_context,
    resolvedProvider,
  );

  // ── Delegated assignment: attempt spawn with fallback chain ────────────────
  // For delegated mode (no provider), attempt subagent spawn now.
  // Emit all telemetry events BEFORE updating dispatch state.
  // Write complete assignment evidence BEFORE worker begins executing.
  if (dispatchRecord.dispatch_mode === "delegated") {
    const assignmentOutcome = attemptDelegatedAssignment(
      telemetryFile,
      dispatchRecord.dispatch_id,
      state.run_id,
      childId,
      packet,
    );
    dispatchRecord.worker_assignment = assignmentOutcome.assignment;
    dispatchRecord.session_id = assignmentOutcome.session_id;
    dispatchRecord.attachment_capable = assignmentOutcome.attachment_capable;
    dispatchRecord.runtime_state = assignmentOutcome.runtime_state;
  }

  // ── Update state atomically with dispatch record ───────────────────────────
  // Assignment evidence is populated in dispatchRecord BEFORE this write.
  // This upholds the evidence-before-execution invariant.
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
    dispatch_mode: dispatchRecord.dispatch_mode,
    runtime_state: dispatchRecord.runtime_state,
    provider: dispatchRecord.provider ?? null,
    timestamp: new Date().toISOString(),
  });

  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
}

// ── Acknowledgment timeout detection ─────────────────────────────────────────

export interface AckTimeoutResult {
  childId: string;
  dispatchId: string;
  orphaned: boolean;
  reason?: string;
}

/**
 * Check if the active child's dispatch has exceeded the acknowledgment timeout.
 * Returns the result of the check and emits recovery telemetry if timeout exceeded.
 *
 * Scenario B: worker_id present, acknowledged_at null, >launch_to_first_heartbeat_ms elapsed.
 * Scenario E: dispatched_at present, state handoff-pending, >stale_dispatch_timeout elapsed.
 */
export function checkAcknowledgmentTimeout(options: {
  stateFile: string;
  repoRoot: string;
  launchToFirstHeartbeatMs?: number;
  staleDispatchTimeoutMs?: number;
}): AckTimeoutResult | null {
  const launchTimeout = options.launchToFirstHeartbeatMs ?? 30_000;
  const staleTimeout = options.staleDispatchTimeoutMs ?? 1_800_000; // 30 min

  let state: LoopState;
  try {
    state = readState(options.stateFile);
  } catch {
    return null;
  }

  if (!state.active_child) return null;

  const childMeta = state.open_children_meta?.[state.active_child];
  const dr = childMeta?.dispatch_record;
  if (!dr) return null;

  const now = Date.now();
  const dispatchedAt = new Date(dr.dispatched_at).getTime();
  const elapsed = now - dispatchedAt;

  const telemetryFile = resolveTelemetryFile(state, options.repoRoot);

  // Scenario B: worker dispatched but not acknowledged within launch timeout
  if (dr.worker_id && !dr.first_heartbeat_at && elapsed > launchTimeout) {
    const recoveryEvent = {
      event: "child-recovery-initiated",
      event_id: randomUUID(),
      child_id: state.active_child,
      dispatch_id: dr.dispatch_id,
      recovery_reason: "no-acknowledgment",
      detected_at: new Date().toISOString(),
    };
    appendTelemetry(telemetryFile, recoveryEvent);

    const orphanEvent = {
      event: "child-orphaned",
      event_id: randomUUID(),
      child_id: state.active_child,
      dispatch_id: dr.dispatch_id,
      last_heartbeat_at: dr.last_heartbeat_at ?? null,
      orphaned_at: new Date().toISOString(),
    };
    appendTelemetry(telemetryFile, orphanEvent);

    // Update runtime_state to orphaned
    const updatedMeta = {
      ...state.open_children_meta,
      [state.active_child]: {
        ...childMeta,
        dispatch_record: { ...dr, runtime_state: "orphaned" as const },
      },
    };
    writeStateAtomic(options.stateFile, { ...state, open_children_meta: updatedMeta });

    return { childId: state.active_child, dispatchId: dr.dispatch_id, orphaned: true, reason: "no-acknowledgment" };
  }

  // Scenario E: stale dispatch — dispatched but state hasn't progressed
  if (dr.runtime_state === "packet-created" && elapsed > staleTimeout) {
    const recoveryEvent = {
      event: "child-recovery-initiated",
      event_id: randomUUID(),
      child_id: state.active_child,
      dispatch_id: dr.dispatch_id,
      recovery_reason: "stale-dispatch",
      detected_at: new Date().toISOString(),
    };
    appendTelemetry(telemetryFile, recoveryEvent);

    const orphanEvent = {
      event: "child-orphaned",
      event_id: randomUUID(),
      child_id: state.active_child,
      dispatch_id: dr.dispatch_id,
      last_heartbeat_at: null,
      orphaned_at: new Date().toISOString(),
    };
    appendTelemetry(telemetryFile, orphanEvent);

    const updatedMeta = {
      ...state.open_children_meta,
      [state.active_child]: {
        ...childMeta,
        dispatch_record: { ...dr, runtime_state: "orphaned" as const },
      },
    };
    writeStateAtomic(options.stateFile, { ...state, open_children_meta: updatedMeta });

    return { childId: state.active_child, dispatchId: dr.dispatch_id, orphaned: true, reason: "stale-dispatch" };
  }

  return { childId: state.active_child, dispatchId: dr.dispatch_id, orphaned: false };
}
