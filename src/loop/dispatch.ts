import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join, isAbsolute, resolve, relative } from "node:path";
import { readState, validateState, writeStateAtomic, type LoopState, type ChildDispatchRecord, type DispatchMode, type WorkerRuntimeState, type WorkerAssignmentRecord } from "./checkpoint.js";
import { compileImplPacket, type WorkerPacket, type WorkerRoleContext } from "./worker-packet.js";
import { loadConfig } from "../config/loader.js";
import { readClusterStateSync, writeClusterStateSync } from "../cluster-state/store.js";
import type { ChildState, ClusterState } from "../cluster-state/types.js";
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
  ProviderSelectedEvent,
  ProviderFallbackAttemptedEvent,
  ProviderExhaustedEvent,
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

const CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Resolve provider from config when no explicit --provider flag is set.
 * Returns the first configured provider in rotation, or undefined if none configured.
 */
interface ProviderDecisionEvidence {
  provider?: string;
  mode: DispatchMode;
  adapter: string;
  selectionReason: string;
  overrideSource?: string;
  fallbackFrom?: string;
  fallbackReason?: string;
  providersTried: string[];
  exhaustedReason?: string;
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
): ProviderDecisionEvidence {
  const defaultAdapter = "terminal-cli";

  if (options.provider) {
    return {
      provider: options.provider,
      mode: "direct-worker",
      adapter: defaultAdapter,
      selectionReason: "cli-provider-override",
      overrideSource: "dispatch-flag",
      providersTried: [options.provider],
    };
  }

  try {
    const config = loadConfig(options.repoRoot);
    const exec = config.execution;
    const adapter = exec?.adapter ?? defaultAdapter;
    const rotation = exec?.rotation ?? [];

    if (rotation.length > 0 && rotation[0]) {
      return {
        provider: rotation[0],
        mode: "direct-worker",
        adapter,
        selectionReason: "config-rotation",
        providersTried: [rotation[0]],
      };
    }

    const providers = Object.keys(exec?.providers ?? {});
    if (providers.length > 0 && providers[0]) {
      return {
        provider: providers[0],
        mode: "direct-worker",
        adapter,
        selectionReason: "config-first-provider",
        fallbackFrom: "rotation",
        fallbackReason: "rotation-empty",
        providersTried: [providers[0]],
      };
    }

    return {
      provider: undefined,
      mode: "delegated",
      adapter,
      selectionReason: "delegated-no-provider",
      providersTried: [],
      exhaustedReason: "no-configured-provider",
    };
  } catch {
    return {
      provider: undefined,
      mode: "delegated",
      adapter: defaultAdapter,
      selectionReason: "delegated-config-unavailable",
      fallbackFrom: "config",
      fallbackReason: "config-unavailable",
      providersTried: [],
      exhaustedReason: "config-unavailable",
    };
  }
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
): { packetPath: string; resultPath: string; relativePacketPath: string; relativeResultPath: string } {
  const packetDir = getClusterPacketDir(repoRoot, clusterId);
  const resultDir = getClusterResultDir(repoRoot, clusterId);
  const filename = `${childId}-${dispatchId}.json`;
  const packetPath = join(packetDir, filename);
  const resultPath = join(resultDir, filename);
  return {
    packetPath,
    resultPath,
    relativePacketPath: relative(repoRoot, packetPath),
    relativeResultPath: relative(repoRoot, resultPath),
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

function emitProviderSelected(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  decision: ProviderDecisionEvidence,
): void {
  appendTelemetry(telemetryFile, {
    event: "provider-selected",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    requested_role: "worker",
    selected_provider: decision.provider ?? null,
    selected_adapter: decision.adapter,
    selection_reason: decision.selectionReason,
    ...(decision.overrideSource ? { override_source: decision.overrideSource } : {}),
    ...(decision.fallbackFrom ? { fallback_from: decision.fallbackFrom } : {}),
    ...(decision.fallbackReason ? { fallback_reason: decision.fallbackReason } : {}),
    ...(decision.providersTried.length > 0 ? { providers_tried: decision.providersTried } : {}),
    timestamp: new Date().toISOString(),
  } satisfies ProviderSelectedEvent);
}

function emitProviderFallbackAttempted(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  decision: ProviderDecisionEvidence,
): void {
  if (!decision.fallbackFrom || !decision.fallbackReason) return;
  appendTelemetry(telemetryFile, {
    event: "provider-fallback-attempted",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    requested_role: "worker",
    fallback_from: decision.fallbackFrom,
    fallback_reason: decision.fallbackReason,
    ...(decision.providersTried.length > 0 ? { providers_tried: decision.providersTried } : {}),
    timestamp: new Date().toISOString(),
  } satisfies ProviderFallbackAttemptedEvent);
}

function emitProviderExhausted(
  telemetryFile: string,
  dispatchId: string,
  runId: string,
  childId: string,
  decision: ProviderDecisionEvidence,
): void {
  if (decision.provider) return;
  appendTelemetry(telemetryFile, {
    event: "provider-exhausted",
    event_id: randomUUID(),
    dispatch_id: dispatchId,
    run_id: runId,
    child_id: childId,
    requested_role: "worker",
    selected_adapter: decision.adapter,
    reason: decision.exhaustedReason ?? "no-provider-selected",
    ...(decision.providersTried.length > 0 ? { providers_tried: decision.providersTried } : {}),
    timestamp: new Date().toISOString(),
  } satisfies ProviderExhaustedEvent);
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
  providerSelectionReason?: string,
  providerOverrideSource?: string,
  providersTried?: string[],
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
    provider_selection_reason: providerSelectionReason,
    provider_override_source: providerOverrideSource,
    providers_tried: providersTried && providersTried.length > 0 ? providersTried : undefined,
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
    branch: state.branch || getCurrentBranch(repoRoot),
    stateFile: canonicalPath(stateFile),
    telemetryFile,
    issueContext,
    maxConcurrentWorkers: 1,
    promptMode: selectPromptMode(childId, state),
    resultFile: resultFile ? canonicalPath(absoluteResultFile(repoRoot, resultFile)) : undefined,
  });
}

function buildClusterStateFromLoopState(state: LoopState, previousGeneration?: number): ClusterState {
  const childOrder = [
    ...state.completed_children,
    ...state.open_children,
    ...(state.active_child ? [state.active_child] : []),
  ];
  const seen = new Set<string>();
  const child_states: ChildState[] = [];

  for (const childId of childOrder) {
    if (!childId || seen.has(childId)) continue;
    seen.add(childId);

    let status: ChildState["status"];
    if (state.completed_children.includes(childId)) {
      status = "done";
    } else if (childId === state.active_child) {
      status = "dispatched";
    } else {
      status = "ready";
    }

    child_states.push({
      id: childId,
      status,
    });
  }

  return {
    schema_version: "1.0",
    cluster_id: state.cluster_id,
    state_generation: previousGeneration !== undefined ? previousGeneration + 1 : 1,
    child_states,
    claim_metadata: {},
    packet_pointers: {},
    result_pointers: {},
    validation_results: {},
    commits: {},
    tracker_mutations: {},
    blockers: [],
  };
}

function syncClusterDispatchState(
  state: LoopState,
  childId: string,
  dispatchRecord: ChildDispatchRecord,
  packetPath: string,
  repoRoot: string,
): void {
  const existingState = readClusterStateSync(state.cluster_id, repoRoot);
  const previousGeneration = existingState?.state_generation;
  const clusterState = existingState ?? buildClusterStateFromLoopState(state, previousGeneration);
  const claimedAt = dispatchRecord.dispatched_at;
  const claimedAtMs = new Date(claimedAt).getTime();
  const expiresAt = new Date(
    Number.isFinite(claimedAtMs) ? claimedAtMs + CLAIM_TTL_MS : Date.now() + CLAIM_TTL_MS,
  ).toISOString();
  const knownChild = clusterState.child_states.some((child) => child.id === childId);
  const child_states = knownChild
    ? clusterState.child_states.map((child) =>
        child.id === childId
          ? {
              ...child,
              status: "dispatched" as const,
            }
          : child,
      )
    : [...clusterState.child_states, { id: childId, status: "dispatched" as const }];

  writeClusterStateSync(
    state.cluster_id,
    {
      ...clusterState,
      state_generation: clusterState.state_generation + 1,
      child_states,
      claim_metadata: {
        ...clusterState.claim_metadata,
        [childId]: {
          worker_id: dispatchRecord.worker_id ?? dispatchRecord.dispatch_id,
          claimed_at: claimedAt,
          expires_at: expiresAt,
        },
      },
      packet_pointers: {
        ...clusterState.packet_pointers,
        [childId]: packetPath,
      },
    },
    repoRoot,
  );
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
  const providerDecision = resolveProviderAndMode(options);
  const { provider: resolvedProvider } = providerDecision;

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
  const { packetPath, resultPath, relativePacketPath, relativeResultPath } = buildClusterArtifactPaths(
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
    relativePacketPath,
    relativeResultPath,
    packet.role_context,
    resolvedProvider,
    providerDecision.selectionReason,
    providerDecision.overrideSource,
    providerDecision.providersTried,
  );

  emitProviderFallbackAttempted(telemetryFile, dispatchRecord.dispatch_id, state.run_id, childId, providerDecision);
  emitProviderExhausted(telemetryFile, dispatchRecord.dispatch_id, state.run_id, childId, providerDecision);
  emitProviderSelected(telemetryFile, dispatchRecord.dispatch_id, state.run_id, childId, providerDecision);

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

  try {
    syncClusterDispatchState(state, childId, dispatchRecord, relativePacketPath, options.repoRoot);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    appendTelemetry(telemetryFile, {
      event: "dispatch-failed",
      run_id: state.run_id,
      child_id: childId,
      error: `Failed to sync cluster-state: ${errorMsg}`,
      timestamp: new Date().toISOString(),
    });
    fail(`Failed to sync cluster-state for ${childId}: ${errorMsg}`);
  }

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
  if (dr.worker_id && !dr.first_heartbeat_at && elapsed > launchTimeout && dr.runtime_state !== "orphaned") {
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
