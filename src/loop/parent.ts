/**
 * Scheduler-only parent loop.
 *
 * The parent loop is a pure scheduler: it reads cluster state, selects the
 * next open child, dispatches a worker via the configured execution adapter,
 * receives a compact return JSON, checks the budget, and loops or halts.
 *
 * The parent MUST NOT inline-execute child work. Every child is dispatched
 * to an external worker. "ADAPTER HANDOFF" means dispatch + continue the loop;
 * it is NOT a signal to halt the parent session.
 *
 * Loop steps:
 *   01 – Load cluster / read current-state.json
 *   02 – Select next open child (lowest-numbered, not Done/blocked)
 *   03 – Dispatch worker via configured adapter
 *   04 – Receive and validate compact worker return JSON
 *   05 – Check budget policy
 *   06 – CONTINUE (back to step 02) or halt (STOP / CLUSTER COMPLETE)
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ensureDeliveryBranch } from "./git-custody.js";
import {
  readState,
  validateState,
  writeStateAtomic,
  readBodyFromClusterSnapshot,
  buildWorkerResultContract,
  computePacketHashFromPath,
  type ChildDispatchRecord,
  type LoopState,
  type ProviderRoutingSummary,
} from "./checkpoint.js";
import type { WorkerResultContract } from "../types/result-packet.js";
import { createAdapter } from "./adapters/registry.js";
import type { BootstrapPacket, WorkerSummary } from "./adapters/types.js";
import { checkBudget, policyFromConfig } from "./budget.js";
import { loadConfig } from "../config/loader.js";
import type { ChildState } from "../cluster-state/types.js";
import { readClusterState, writeClusterState, pruneExpiredClaims } from "../cluster-state/store.js";
import { WorkerLifecycleManager } from "./lifecycle.js";
import { compileImplPacket, type WorkerPacket } from "./worker-packet.js";
import { selectPromptMode } from "./worker-prompt.js";
import { parseIssueBody } from "./body-parser.js";
import { execFileSync } from "node:child_process";
import { classifyArtifactPath } from "../finalize/artifact-policy.js";
import {
  INLINE_EXECUTION_ERROR,
  assertNoActiveChildBeforeDispatch,
  assertDispatchedBeforeCompletion,
  advanceDispatchEpoch,
  advanceContinueEpoch,
  assertChildQcSelectionAllowed,
} from "./dispatch-boundary.js";
import { selectChildQcTrigger } from "../qc/triggers.js";
import { runQcAtTrigger, createQcRegistry } from "../qc/index.js";
import { runQcRepairLoop, DEFAULT_MAX_REPAIR_ROUNDS, type DispatchRepairWorkerFn } from "../qc/repair-loop.js";
import { compileRepairWorkerPacket } from "./worker-packet.js";
import type { QcRepairLoopState } from "./checkpoint.js";
import { assertBootstrapSeal } from "./run-bootstrap.js";
import {
  DEFAULT_LEDGER_PATH,
  LedgerWriter,
  type ChildCompletedEvent,
  type ClusterCompleteEvent,
  type LedgerRunType,
  type RunStartedEvent,
} from "./ledger.js";
import { resolveProviderAndMode, assertProviderAllowedForRole } from "./dispatch.js";
import { decideWorkerRoute } from "./router/index.js";
import { selectChildSlotClaims, type SlotClaim } from "../runtime/scheduling/child-selector.js";
import { loadTrackerAdapter, loadTrackerGraph } from "../tracker/index.js";
import { LifecycleTransitionService } from "../tracker/lifecycle-transition.js";
import { LocalGraph } from "../tracker/local-graph.js";
import { upsertWorkerSymptoms, readRunHealthReport, getRunHealthReportPath, isMedicGateSatisfied } from "../run-health/index.js";
import { appendForemanSymptom } from "../run-health/foreman-symptoms.js";
import { appendQcEscalationSymptoms, appendRepairLoopOutcomeSymptom } from "../run-health/qc-escalation.js";
import type { WorkerRunHealthSymptom, MedicRunHealthPacket } from "../types/result-packet.js";
import { runMedicRunHealthConsult } from "../medic/run-health-consult.js";
import { dispatchTreatmentWorker } from "../medic/treatment-packets.js";

const CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Returns the list of files touched by a git commit, or null when the commit
 * cannot be resolved (short hash in a non-repo context, or non-existent object).
 * Returns null (fail-open) for short/non-hex hashes so test environments using
 * synthetic commit strings like "abc1234" are not blocked by the artifact gate.
 * For full 40-char SHAs, resolves via git and returns null on any git failure.
 */
function defaultGetCommitFiles(commit: string, repoRoot: string): string[] | null {
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    // Short or non-hex hash — cannot verify without git resolution; skip check.
    return null;
  }
  try {
    // Resolve the ref to a commit OID, rejecting non-commit refs.
    const resolvedCommit = execFileSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const output = execFileSync("git", ["show", "--name-only", "--format=", resolvedCommit], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    // Cannot resolve even a full-looking SHA — skip check rather than block.
    return null;
  }
}

/**
 * Returns true when a parsed `## Goal` section text looks like placeholder
 * or template content that has not been filled in.
 * Impl-only gate — analyze children are exempted by their caller.
 */
function isPlaceholderGoal(goal: string): boolean {
  const t = goal.trim().toLowerCase();
  if (t.length === 0) return true;
  if (t === 'tbd') return true;
  if (t.startsWith('tbd ') || t.startsWith('tbd—') || t.startsWith('tbd -') || t.startsWith('tbd:')) return true;
  if (t === 'todo') return true;
  if (t.startsWith('todo:') || t.startsWith('todo ')) return true;
  if (t === 'placeholder') return true;
  if (t.startsWith('[placeholder]') || t.startsWith('<<') || t.startsWith('<placeholder')) return true;
  return false;
}

function logStatus(
  format: "verbose" | "terse" | undefined,
  message: string,
) {
  if (format === "terse") {
    process.stdout.write(`[POLARIS] ${message}\n`);
  }
}

export interface ParentLoopOptions {
  /** Absolute path to current-state.json. */
  stateFile: string;
  /** Repository root (used to locate polaris.config.json). */
  repoRoot: string;
  /**
   * Override the adapter name from config (e.g. "terminal-cli", "agent-subtask").
   * When omitted, the adapter configured in polaris.config.json is used.
   */
  adapter?: string;
  /**
   * Override the provider name used within the adapter.
   * When omitted, the first provider in config.execution.rotation is used,
   * falling back to the first key in config.execution.providers.
   */
  provider?: string;
  /**
   * If true, run in dry-run mode: log each dispatch without executing.
   */
  dryRun?: boolean;
  /**
   * If true, allow analyze-type children to be dispatched in an impl session.
   * Overrides budget.allow_analyze_children from config.
   */
  allowAnalyzeChildren?: boolean;
  /**
   * Optional override for getting files changed in a git commit.
   * Injected for testing; defaults to `defaultGetCommitFiles`.
   * Returns null to skip the artifact check (fail-open) when the commit
   * cannot be resolved. Returning an array triggers the artifact-only gate.
   */
  getCommitFiles?: (commit: string, repoRoot: string) => string[] | null;
}

export type ParentLoopHaltReason =
  | 'cluster-complete' // All children done
  | 'budget-exhausted' // Budget cap reached
  | 'blocked' // A child reported a blocker
  | 'worker-error' // Worker returned a non-zero exit code or error status
  | 'state-invalid' // current-state.json failed validation
  | 'analyze-parent' // Cluster root is an ANALYZE issue
  | 'analyze-drift' // Next child is an analyze issue and allow_analyze_children is false
  | 'supervised-mode-child-complete' // Child completed in supervised mode
  | 'preflight-failed'; // A child failed preflight validation (e.g. missing body)

export interface ParentLoopResult {
  /** Final halt reason. */
  haltReason: ParentLoopHaltReason;
  /** Number of children successfully dispatched and completed this session. */
  childrenDispatched: number;
  /** The child ID that caused a halt (if relevant). */
  haltingChild?: string;
  /** Human-readable description of the halt. */
  message: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────────

function appendTelemetry(telemetryFile: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(telemetryFile), { recursive: true });
  appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
}

function resolveTelemetryFile(state: LoopState, repoRoot: string): string {
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  return join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
}

function estimateTokensFromBytes(bytes: number): number {
  return Math.round(bytes / 4);
}

function emitBootstrapContextSize(
  telemetryFile: string,
  runId: string,
  childId: string,
  stateFile: string,
  packet: WorkerPacket,
): void {
  const stateFileBytes = statSync(stateFile).size;
  const bootstrapPacketBytes = Buffer.byteLength(JSON.stringify(packet), "utf-8");
  const stateEstimatedTokens = estimateTokensFromBytes(stateFileBytes);
  const bootstrapEstimatedTokens = estimateTokensFromBytes(bootstrapPacketBytes);
  appendTelemetry(telemetryFile, {
    event: "bootstrap-context-size",
    run_id: runId,
    child_id: childId,
    state_file_bytes: stateFileBytes,
    state_estimated_tokens: stateEstimatedTokens,
    bootstrap_packet_bytes: bootstrapPacketBytes,
    bootstrap_estimated_tokens: bootstrapEstimatedTokens,
    combined_estimated_tokens: stateEstimatedTokens + bootstrapEstimatedTokens,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Returns true when the given child is detected as an analyze issue.
 * Detection is intentionally conservative: title prefix or label match only.
 */
function isAnalyzeChild(childId: string, state: LoopState): boolean {
  const meta = state.open_children_meta?.[childId];
  if (!meta) return false;
  const title = meta.title ?? "";
  if (title.startsWith("Analyze:") || title.startsWith("polaris-analyze")) return true;
  if (meta.labels?.includes("analyze")) return true;
  return false;
}

/**
 * Returns true when the cluster root is an ANALYZE issue.
 */
function isAnalyzeParent(state: LoopState): boolean {
  const meta = state.open_children_meta?.[state.cluster_id];
  if (!meta) return false;
  const title = meta.title ?? "";
  if (title.startsWith("ANALYZE:")) return true;
  if (meta.labels?.includes("analyze")) return true;
  return false;
}

/** Normalise a file path to its canonical realpath (resolves macOS /var → /private/var symlinks). */
function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Returns the current git branch, or "unknown" on failure. */
function getCurrentBranch(cwd: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf-8",
    }).trim();
  } catch {
    return (process.env["POLARIS_BRANCH"] as string | undefined) ?? "unknown";
  }
}

function normalizeRunType(sessionType: string | undefined): LedgerRunType {
  return sessionType === "analyze" ? "analyze" : "implement";
}

function ledgerLastCommit(state: LoopState): string | null {
  return state.last_commit && state.last_commit.length > 0 ? state.last_commit : null;
}

function appendRunStartedLedgerEvent(repoRoot: string, state: LoopState): void {
  new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH)).append({
    schema_version: 1,
    event_id: randomUUID(),
    event: "run-started",
    run_id: state.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id,
    issue_id: state.active_child || null,
    branch: state.branch ?? getCurrentBranch(repoRoot),
    status: "running",
    completed_children: state.completed_children,
    open_children: state.open_children,
    next_child: state.next_open_child,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp: new Date().toISOString(),
  } satisfies RunStartedEvent);
}

function appendChildCompletedLedgerEvent(
  repoRoot: string,
  state: LoopState,
  completedChild: string,
  lastCommit: string | null,
  validation: unknown,
  completion?: {
    dispatchId?: string;
    provider?: string | null;
    model?: string | null;
    elapsedSeconds?: number;
    commitFiles?: string[] | null;
    completionStatus?: "done" | "blocked" | "error";
    routerSelectionReason?: string;
    providersTried?: string[];
    routingSummary?: ProviderRoutingSummary;
  },
): void {
  const writer = new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH));
  const base = {
    schema_version: 1 as const,
    event_id: randomUUID(),
    run_id: state.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id,
    branch: state.branch ?? getCurrentBranch(repoRoot),
    completed_children: state.completed_children,
    open_children: state.open_children,
    next_child: state.next_open_child,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp: new Date().toISOString(),
  };

  writer.append({
    ...base,
    event: "child-completed",
    issue_id: completedChild,
    status: state.status === "cluster-complete" ? "cluster-complete" : "running",
    last_commit: lastCommit,
    validation: typeof validation === "object" && validation !== null
      ? { status: "complete", ...(validation as Record<string, unknown>) }
      : { status: "complete" },
    ...(completion?.dispatchId ? { dispatch_id: completion.dispatchId } : {}),
    provider: completion?.provider ?? null,
    model: completion?.model ?? null,
    ...(completion?.elapsedSeconds !== undefined ? { elapsed_seconds: completion.elapsedSeconds } : {}),
    ...(completion?.commitFiles !== undefined ? { commit_files: completion.commitFiles } : {}),
    ...(completion?.completionStatus ? { completion_status: completion.completionStatus } : {}),
    ...(completion?.routerSelectionReason
      ? { router_selection_reason: completion.routerSelectionReason }
      : {}),
    ...(completion?.providersTried?.length
      ? { providers_tried: completion.providersTried }
      : {}),
    ...(completion?.routingSummary ? { routing_summary: completion.routingSummary } : {}),
  } satisfies ChildCompletedEvent);
}

function appendClusterCompletedLedgerEvent(repoRoot: string, state: LoopState): void {
  const writer = new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH));
  const base = {
    schema_version: 1 as const,
    event_id: randomUUID(),
    run_id: state.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id,
    branch: state.branch ?? getCurrentBranch(repoRoot),
    completed_children: state.completed_children,
    open_children: state.open_children,
    next_child: state.next_open_child,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp: new Date().toISOString(),
  };

  writer.append({
    ...base,
    event_id: randomUUID(),
    event: "cluster-complete",
    issue_id: null,
    status: "cluster-complete",
    open_children: [],
    next_child: null,
    recovery_count: 0,
  } satisfies ClusterCompleteEvent);
}

/**
 * Builds the compiled WorkerPacket used to dispatch an implementation (impl) child.
 *
 * @param stateFile - Absolute path to the current-state.json file used by the worker
 * @param telemetryFile - Path to the telemetry JSONL file the worker should append to
 * @param repoRoot - Repository root used to resolve branch and paths
 * @param resultFile - Optional override path where the worker should write its result
 * @returns The compiled WorkerPacket configured for `activeChild`
 */
function buildPacket(
  state: LoopState,
  activeChild: string,
  stateFile: string,
  telemetryFile: string,
  repoRoot: string,
  resultFile: string,
  maxConcurrentWorkers: number,
): WorkerPacket {
  const branch = state.branch ?? getCurrentBranch(repoRoot);

  const childMeta = state.open_children_meta?.[activeChild];
  // Hydrate body from cluster snapshot when runtime state lacks it.
  const cachedBody = childMeta?.body;
  const resolvedChildBody = (cachedBody && cachedBody.trim().length > 0)
    ? cachedBody
    : readBodyFromClusterSnapshot(state.cluster_id, activeChild, repoRoot);

  const issueContext = (childMeta || resolvedChildBody)
    ? {
        id: activeChild,
        title: childMeta?.title ?? activeChild,
        key_requirements: [],
        body: resolvedChildBody,
      }
    : undefined;

  // Scope precedence: child body → parent/cluster-root body fallback.
  // Derive here so compileImplPacket receives an authoritative scope list
  // rather than falling back to [] when the child body has no scope section.
  const childScope = resolvedChildBody ? parseIssueBody(resolvedChildBody).scope : [];
  const cachedParentBody = state.open_children_meta?.[state.cluster_id]?.body;
  const parentBodyForScope = (cachedParentBody && cachedParentBody.trim().length > 0)
    ? cachedParentBody
    : readBodyFromClusterSnapshot(state.cluster_id, state.cluster_id, repoRoot) ?? '';
  const resolvedScope = childScope.length > 0
    ? childScope
    : parseIssueBody(parentBodyForScope).scope;

  const promptMode = selectPromptMode(activeChild, state);

  return compileImplPacket({
    runId: state.run_id,
    clusterId: state.cluster_id,
    childId: activeChild,
    branch,
    stateFile: canonicalPath(stateFile),
    telemetryFile,
    issueContext,
    allowedScope: resolvedScope.length > 0 ? resolvedScope : undefined,
    maxConcurrentWorkers,
    promptMode,
    resultFile,
  });
}

function absoluteResultFile(repoRoot: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath);
}

/**
 * Flush bodies from open_children_meta to the durable clusters.json snapshot.
 * Called once before the dispatch loop so that writeStateAtomic (which strips
 * body from non-next children) does not cause data loss when the loop reloads
 * state from disk between dispatches.
 *
 * Only writes nodes that have a body in open_children_meta but lack one in the
 * existing snapshot. Never removes or overwrites existing body data.
 * Never throws.
 */
function flushBodiesToClusterSnapshot(state: LoopState, repoRoot: string): void {
  const meta = state.open_children_meta;
  if (!meta) return;

  const snapshotPath = join(repoRoot, ".polaris", "clusters", state.cluster_id, "clusters.json");
  let snapshot: {
    schemaVersion?: string;
    nodes?: Record<string, { id?: string; title?: string; body?: string; status?: string }>;
    [key: string]: unknown;
  } = {};

  try {
    const raw = readFileSync(snapshotPath, "utf-8");
    snapshot = JSON.parse(raw) as typeof snapshot;
  } catch (err) {
    // Distinguish "file not found" from "present but corrupted"
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      // File absent — start fresh
      snapshot = {
        schemaVersion: "v2",
        source: { id: state.cluster_id, type: "local" },
        nodes: {},
        dependencies: {},
        clusters: { [state.cluster_id]: { id: state.cluster_id, title: state.cluster_id, children: state.open_children } },
        activeCluster: state.cluster_id,
      };
    } else {
      // File present but corrupted — do not overwrite
      return;
    }
  }

  if (typeof snapshot.nodes !== "object" || snapshot.nodes === null) {
    snapshot.nodes = {};
  }

  let changed = false;
  for (const [id, childMeta] of Object.entries(meta)) {
    const body = childMeta?.body;
    if (!body || body.trim().length === 0) continue;
    const existing = snapshot.nodes[id];
    if (existing && existing.body && existing.body.trim().length > 0) continue;
    snapshot.nodes[id] = {
      ...(existing ?? {}),
      id,
      title: childMeta.title ?? existing?.title ?? id,
      body,
      status: existing?.status ?? "Todo",
    };
    changed = true;
  }

  if (!changed) return;

  try {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch {
    // Best-effort — do not fail the loop if snapshot write fails
  }
}

function buildClusterArtifactPaths(
  repoRoot: string,
  clusterId: string,
  childId: string,
  dispatchId: string,
): { packetPath: string; resultPath: string } {
  const clusterDir = join(repoRoot, ".polaris", "clusters", clusterId);
  const filename = `${childId}-${dispatchId}.json`;
  return {
    packetPath: join(clusterDir, "packets", filename),
    resultPath: join(clusterDir, "results", filename),
  };
}

function writePacketArtifact(packetPath: string, packet: WorkerPacket): void {
  mkdirSync(dirname(packetPath), { recursive: true });
  writeFileSync(packetPath, JSON.stringify(packet, null, 2), "utf-8");
}

function childResultFilePath(
  state: LoopState,
  childId: string,
  repoRoot: string,
  dispatchId: string,
): string {
  const configured = state.open_children_meta?.[childId]?.result_file;
  if (configured && configured.trim().length > 0) {
    return absoluteResultFile(repoRoot, configured);
  }
  return buildClusterArtifactPaths(repoRoot, state.cluster_id, childId, dispatchId).resultPath;
}

function buildParentDispatchRecord(args: {
  dispatchId: string;
  runId: string;
  clusterId: string;
  childId: string;
  packetPath: string;
  resultPath: string;
  provider: string;
  providerSelectionReason?: string;
  providersTried?: string[];
  routingSummary?: ProviderRoutingSummary;
  workerId: string;
  dispatchedAt: string;
}): ChildDispatchRecord {
  return {
    dispatch_id: args.dispatchId,
    child_id: args.childId,
    run_id: args.runId,
    cluster_id: args.clusterId,
    packet_path: args.packetPath,
    expected_result_path: args.resultPath,
    provider: args.provider,
    provider_selection_reason: args.providerSelectionReason,
    providers_tried: args.providersTried,
    routing_summary: args.routingSummary,
    dispatched_at: args.dispatchedAt,
    status: "dispatched",
    dispatch_mode: "direct-worker",
    runtime_state: "packet-created",
    worker_id: args.workerId,
    session_id: null,
    attachment_capable: false,
    role: "worker",
    role_authority: "implementation",
    may_implement: true,
    session_type: "implementation",
  };
}

function withChildDispatchMetadata(
  state: LoopState,
  childId: string,
  resultFile: string,
  dispatchRecord: ChildDispatchRecord,
): LoopState {
  const current = state.open_children_meta?.[childId];
  if (
    current?.result_file === resultFile &&
    current.dispatch_record?.dispatch_id === dispatchRecord.dispatch_id
  ) {
    return state;
  }
  return {
    ...state,
    open_children_meta: {
      ...(state.open_children_meta ?? {}),
      [childId]: {
        ...(current ?? {}),
        result_file: resultFile,
        dispatch_record: dispatchRecord,
      },
    },
  };
}

/**
 * Parse a compact worker return JSON from the dispatch result summary.
 * Returns null if parsing fails.
 */
function parseWorkerSummary(summary: string | undefined): WorkerSummary | null {
  if (!summary) return null;
  try {
    const parsed = JSON.parse(summary) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as WorkerSummary;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Update state after a child completes successfully.
 * Moves the child from open_children to completed_children.
 */
function advanceState(state: LoopState, completedChild: string, lastCommit?: string): LoopState {
  const remaining = state.open_children.filter((c) => c !== completedChild);
  const completed = [...state.completed_children, completedChild];
  return {
    ...state,
    active_child: "",
    open_children: remaining,
    completed_children: completed,
    next_open_child: remaining[0] ?? null,
    step_cursor: "checkpoint",
    status: remaining.length > 0 ? "running" : "cluster-complete",
    last_commit: lastCommit ?? state.last_commit,
    context_budget: {
      ...state.context_budget,
      children_completed: completed.length,
    },
  };
}

function withWorkerPoolState(
  state: LoopState,
  maxConcurrentWorkers: number,
  slotClaims: SlotClaim[],
): LoopState {
  return {
    ...state,
    worker_pool_state: {
      max_concurrent: maxConcurrentWorkers,
      slot_claims: slotClaims,
    },
  };
}

function pruneWorkerPoolClaimsForChild(state: LoopState, childId: string): LoopState {
  if (!state.worker_pool_state) return state;
  return {
    ...state,
    worker_pool_state: {
      ...state.worker_pool_state,
      slot_claims: state.worker_pool_state.slot_claims.filter((claim) => claim.child_id !== childId),
    },
  };
}

async function syncClusterCompletion(args: {
  clusterId: string;
  childId: string;
  repoRoot: string;
  resultFile?: string;
  validationSummary?: unknown;
  lastCommit?: string;
}): Promise<boolean> {
  const clusterState = await readClusterState(args.clusterId, args.repoRoot);
  if (!clusterState) {
    console.warn(
      `[polaris] syncClusterCompletion: no cluster state found for clusterId=${args.clusterId}; skipping sync`,
    );
    return false;
  }

  const childStates: ChildState[] = clusterState.child_states.some((child) => child.id === args.childId)
    ? clusterState.child_states.map((child) =>
        child.id === args.childId
          ? {
              ...child,
              status: "done",
              commit: args.lastCommit ?? child.commit,
            }
          : child,
      )
    : [
        ...clusterState.child_states,
        {
          id: args.childId,
          status: "done",
          ...(args.lastCommit ? { commit: args.lastCommit } : {}),
        },
      ];

  const nextValidationResults =
    args.validationSummary === undefined
      ? clusterState.validation_results
      : {
          ...clusterState.validation_results,
          [args.childId]: {
            passed: true,
            output: String(args.validationSummary),
          },
        };

  await writeClusterState(
    args.clusterId,
    {
      ...clusterState,
      state_generation: clusterState.state_generation + 1,
      child_states: childStates,
      claim_metadata: Object.fromEntries(
        Object.entries(clusterState.claim_metadata).filter(([childId]) => childId !== args.childId),
      ),
      result_pointers: args.resultFile
        ? {
            ...clusterState.result_pointers,
            [args.childId]: args.resultFile,
          }
        : clusterState.result_pointers,
      validation_results: nextValidationResults,
      commits: args.lastCommit
        ? {
            ...clusterState.commits,
            [args.childId]: args.lastCommit,
          }
        : clusterState.commits,
    },
    args.repoRoot,
  );
  return true;
}

async function syncClusterDispatch(args: {
  clusterId: string;
  childId: string;
  repoRoot: string;
  packetPath: string;
  workerId: string;
  dispatchedAt: string;
}): Promise<boolean> {
  const clusterState = await readClusterState(args.clusterId, args.repoRoot);
  if (!clusterState) {
    console.warn(
      `[polaris] syncClusterDispatch: no cluster state found for clusterId=${args.clusterId}; skipping sync`,
    );
    return false;
  }

  const dispatchedAtMs = new Date(args.dispatchedAt).getTime();
  const expiresAt = new Date(
    Number.isFinite(dispatchedAtMs) ? dispatchedAtMs + CLAIM_TTL_MS : Date.now() + CLAIM_TTL_MS,
  ).toISOString();

  const childStates: ChildState[] = clusterState.child_states.some((child) => child.id === args.childId)
    ? clusterState.child_states.map((child) =>
        child.id === args.childId
          ? {
              ...child,
              status: "dispatched",
            }
          : child,
      )
    : [...clusterState.child_states, { id: args.childId, status: "dispatched" }];

  await writeClusterState(
    args.clusterId,
    {
      ...clusterState,
      state_generation: clusterState.state_generation + 1,
      child_states: childStates,
      claim_metadata: {
        ...clusterState.claim_metadata,
        [args.childId]: {
          worker_id: args.workerId,
          claimed_at: args.dispatchedAt,
          expires_at: expiresAt,
        },
      },
      packet_pointers: {
        ...clusterState.packet_pointers,
        [args.childId]: args.packetPath,
      },
    },
    args.repoRoot,
  );
  return true;
}

// ────────────────────────────────────────────────────────────────────────────
// Main parent loop
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run the scheduler-only parent loop.
 *
 * This function is the entry point for the `polaris loop run` command and
 * for programmatic use. It loops until a halt condition is reached, then
 * returns a structured result describing why it halted.
 */
export async function runParentLoop(options: ParentLoopOptions): Promise<ParentLoopResult> {
  const { stateFile, repoRoot, dryRun = false, allowAnalyzeChildren: allowAnalyzeChildrenFlag = false } = options;
  // getCommitFiles intentionally read via options.getCommitFiles in the gate below

  // ── Step 01: Load cluster / read current-state.json ─────────────────────

  let state: LoopState;
  try {
    const rawState = readState(stateFile);
    const errors = validateState(rawState);
    if (errors.length > 0) {
      return {
        haltReason: 'state-invalid',
        childrenDispatched: 0,
        message: `current-state.json is invalid:\n${errors.join("\n")}`,
      };
    }
    state = rawState;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      haltReason: 'state-invalid',
      childrenDispatched: 0,
      message: `Cannot read state file ${stateFile}: ${msg}`,
    };
  }

  if (isAnalyzeParent(state)) {
    return {
      haltReason: 'analyze-parent',
      childrenDispatched: 0,
      message: "polaris-run targets IMPLEMENT parents, not ANALYZE issues. Run polaris-analyze first to create an IMPLEMENT parent.",
    };
  }

  // ── Bootstrap seal enforcement ─────────────────────────────────────────────
  // The run MUST have been initialized through `polaris loop bootstrap`.
  // Refuse to enter the dispatch loop if the state was hand-crafted.
  const earlyTelemetry = resolveTelemetryFile(state, repoRoot);
  try {
    assertBootstrapSeal(state, earlyTelemetry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!dryRun) {
      appendTelemetry(earlyTelemetry, {
        event: "bootstrap-seal-missing",
        run_id: state.run_id,
        error: msg,
        timestamp: new Date().toISOString(),
      });
    }
    return {
      haltReason: 'state-invalid',
      childrenDispatched: 0,
      message: msg,
    };
  }

  if (!dryRun) {
    appendRunStartedLedgerEvent(repoRoot, state);
  }

  // Load config for adapter and provider resolution
  const config = loadConfig(repoRoot);
  const legacyOrchestrationMode = (state as unknown as Record<string, unknown>)["orchestration_mode"];
  const legacyEphemeralMode = options.adapter === undefined && legacyOrchestrationMode === "ephemeral";
  const orchestrationMode = config.orchestration?.mode ?? (legacyOrchestrationMode === "ephemeral" ? "auto" : "supervised");
  const telemetryOrchestrationMode = legacyOrchestrationMode === "ephemeral" ? "ephemeral" : orchestrationMode;
  const notificationFormat = config.orchestration?.notification_format ?? (orchestrationMode === 'auto' ? 'terse' : 'verbose');
  const adapterName =
    legacyEphemeralMode ? "agent-subtask" : (options.adapter ?? config.execution?.adapter ?? "terminal-cli");
  let providerName: string;
  let providerSelectionReason: string | undefined;
  let providersTried: string[] | undefined;
  let routingSummary: ProviderRoutingSummary | undefined;
  if (adapterName === "agent-subtask") {
    providerName = "agent-subtask";
    providerSelectionReason = "agent-subtask-adapter";
    providersTried = ["agent-subtask"];
    routingSummary = {
      selected_provider: "agent-subtask",
      selected_adapter: "agent-subtask",
      selection_reason: "agent-subtask-adapter",
      effective_policy_order: ["agent-subtask"],
      compatibility_mode: false,
      registry_present: false,
      fallback_eligible: false,
    };
  } else {
    let evidence;
    try {
      evidence = resolveProviderAndMode(
        { stateFile, repoRoot, provider: options.provider },
        "worker",
        config,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        haltReason: "worker-error",
        childrenDispatched: 0,
        message: msg,
      };
    }
    providerName = evidence.provider ?? "default";
    providerSelectionReason = evidence.selectionReason;
    providersTried = evidence.providersTried;
    routingSummary = evidence.routingSummary;
  }

  const executionConfig =
    adapterName === "agent-subtask"
      ? { ...(config.execution ?? { providers: {} }), adapter: "agent-subtask" }
      : config.execution ?? { adapter: adapterName, providers: {} };
  const adapter = createAdapter(adapterName, executionConfig);
  const budgetPolicy = policyFromConfig(state.context_budget, config.budget);
  const allowAnalyzeChildren = allowAnalyzeChildrenFlag || (config.budget?.allow_analyze_children === true);
  const maxConcurrentWorkers = config.execution?.routerPolicy?.defaultWorkerPool?.maxActiveWorkers ?? 1;
  const telemetryFile = resolveTelemetryFile(state, repoRoot);

  // Enforce provider policy for explicit --provider flag before entering the loop.
  // resolveProviderAndMode handles policy-filtered rotation; this gate blocks an
  // explicit provider that the rotation resolution would not have chosen.
  if (options.provider && adapterName !== "agent-subtask") {
    try {
      assertProviderAllowedForRole(
        "worker",
        options.provider,
        config.execution?.providerPolicy,
        telemetryFile,
        "parent-preflight",
        state.run_id,
        "pre-loop",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        haltReason: "worker-error",
        childrenDispatched: 0,
        message: msg,
      };
    }
  }

  // ── Branch pre-flight ──────────────────────────────────────────────────────
  // Ensure the working tree is on the cluster's delivery branch before any
  // worker is dispatched. Without this, workers commit to whatever branch the
  // operator left HEAD on (often main), bypassing delivery-branch custody and
  // making PR creation impossible for those commits.
  if (!dryRun && adapterName !== "agent-subtask") {
    const deliveryBranch = state.branch;
    if (deliveryBranch && deliveryBranch.trim().length > 0) {
      const currentBranch = getCurrentBranch(repoRoot);
      if (currentBranch !== "unknown" && currentBranch !== deliveryBranch) {
        try {
          ensureDeliveryBranch(repoRoot, deliveryBranch);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            haltReason: 'worker-error',
            childrenDispatched: 0,
            message: `Branch pre-flight: cannot switch to delivery branch "${deliveryBranch}" (current: "${currentBranch}"): ${msg}`,
          };
        }
      }
    }
  }

  let childrenDispatched = 0;

  // ── Flush bodies to clusters.json before stripping begins ──────────────
  // writeStateAtomic strips body from all open_children_meta entries except
  // open_children[0]. Flush any bodies present in open_children_meta to the
  // durable cluster snapshot so readBodyFromClusterSnapshot can hydrate them
  // on subsequent iterations after reload from disk.
  if (!dryRun) {
    flushBodiesToClusterSnapshot(state, repoRoot);
  }

  let localGraph: LocalGraph | null = null;
  try {
    localGraph = await LocalGraph.load(state.cluster_id, repoRoot);
  } catch {
    localGraph = null;
  }

  // ── Lifecycle manager: enforce one-active-worker policy ─────────────────
  // forceReleaseAll() clears any orphaned registrations from a previous
  // crashed session. Registrations are session-memory only; they are not
  // persisted to disk, so a fresh loop start always begins clean.
  const lifecycle = new WorkerLifecycleManager(maxConcurrentWorkers);
  lifecycle.forceReleaseAll();

  // ── Auto-sync pre-flight: fetch missing issue bodies from tracker ────────
  // When child issue bodies are absent or lack a ## Scope section, dispatch
  // hard-fails with "empty allowed_scope". Attempt a silent tracker sync-in
  // before the loop starts so operators don't need to run it manually.
  if (!dryRun) {
    const openChildrenNeedingScope = state.open_children.filter((childId) => {
      // Skip analyze children — they never need scope (no impl packets)
      if (isAnalyzeChild(childId, state)) {
        return false;
      }

      // Resolve child body: prefer cached meta body, then fall back to snapshot
      const cachedChildBody = state.open_children_meta?.[childId]?.body;
      const childBody = (cachedChildBody && cachedChildBody.trim().length > 0)
        ? cachedChildBody
        : readBodyFromClusterSnapshot(state.cluster_id, childId, repoRoot) ?? '';

      // If body is completely absent, treat as needing scope sync-in
      if (childBody.trim().length === 0) {
        return true;
      }

      // Parse child body for scope
      const { scope: childScope } = parseIssueBody(childBody);
      if (childScope.length > 0) {
        return false; // Child has scope, no sync needed
      }

      // Fallback: check parent/cluster-root body for scope
      const cachedParentBody = state.open_children_meta?.[state.cluster_id]?.body;
      const parentBody = (cachedParentBody && cachedParentBody.trim().length > 0)
        ? cachedParentBody
        : readBodyFromClusterSnapshot(state.cluster_id, state.cluster_id, repoRoot) ?? '';
      const { scope: parentScope } = parseIssueBody(parentBody);

      // If parent has scope, child can inherit — no sync needed
      // Otherwise, child truly needs scope sync-in
      return parentScope.length === 0;
    });

    if (openChildrenNeedingScope.length > 0) {
      process.stderr.write(
        `[polaris] ${openChildrenNeedingScope.length} children missing scope — attempting tracker sync-in...\n`,
      );
      try {
        await loadTrackerGraph(config, state.cluster_id);
        process.stderr.write(`[polaris] sync-in complete.\n`);
      } catch (syncErr) {
        process.stderr.write(
          `[polaris] sync-in failed (${syncErr instanceof Error ? syncErr.message : String(syncErr)}). ` +
          `Run 'polaris tracker sync-in ${state.cluster_id}' manually and retry.\n`,
        );
      }
    }
  }

  // ── Main dispatch loop ───────────────────────────────────────────────────
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Step 02: Select next open child ─────────────────────────────────
    const existingSlotClaims = state.worker_pool_state?.slot_claims ?? [];

    if (!dryRun) {
      const clusterState = await readClusterState(state.cluster_id, repoRoot);
      if (clusterState) {
        const pruned = pruneExpiredClaims(clusterState);
        if (pruned.expiredChildIds.length > 0) {
          await writeClusterState(state.cluster_id, pruned.state, repoRoot);
        }
      }
    }

    const selection = selectChildSlotClaims({
      open_children: state.open_children,
      completed_children: state.completed_children,
      active_child: state.active_child || null,
      existing_claims: existingSlotClaims,
      max_concurrent: maxConcurrentWorkers,
      claim_ttl_ms: CLAIM_TTL_MS,
      get_dependencies: (childId) => localGraph?.getDependencies(childId) ?? [],
      decide_route: ({ activeSlotsByProvider }) =>
        decideWorkerRoute({
          role: "worker",
          taskType: "impl",
          adapter: adapterName,
          providerOverride: options.provider,
          providers: Object.keys(config.execution?.providers ?? {}),
          rotation: config.execution?.rotation ?? [],
          rolePolicy: config.execution?.providerPolicy?.worker,
          roleConfiguredProvider: config.execution?.roles?.worker?.provider,
          routerPolicy: config.execution?.routerPolicy,
          constraints: {
            requiredCapabilities: ["implementation"],
          },
          runtime: {
            activeSlotsByProvider,
          },
          compatibilityMode: false,
        }),
    });
    const nextSlotClaims = selection.slot_claims;
    const nextChild = selection.selected_child;

    if (nextChild === null) {
      if (state.open_children.length > 0) {
        if (!dryRun) {
          appendTelemetry(telemetryFile, {
            event: "scheduler-no-eligible-child",
            run_id: state.run_id,
            open_children: state.open_children,
            rejected_children: selection.rejected_children,
            slot_claims: nextSlotClaims,
            timestamp: new Date().toISOString(),
          });
        }
        return {
          haltReason: "blocked",
          childrenDispatched,
          message: "No schedulable child matched dependency and router slot constraints.",
        };
      }
      const autoFinalizeRequested = orchestrationMode === "auto" && config.orchestration?.auto_finalize === true;

      // ── QC repair loop (post-completion gate) ─────────────────────────────
      // When QC is enabled, run the completed-cluster QC trigger and, if
      // findings are produced, run the bounded repair loop before halting.
      // The repair loop is Foreman-owned: it dispatches repair workers via the
      // same adapter and NEVER implements repairs inline.
      if (!dryRun && config.qc?.enabled) {
        const qcRegistry = createQcRegistry(config.qc);
        let initialQcResult;
        try {
          initialQcResult = await runQcAtTrigger({
            config: config.qc,
            registry: qcRegistry,
            trigger: "completed-cluster",
            repoRoot,
            runId: state.run_id,
            clusterId: state.cluster_id,
            branch: state.branch ?? getCurrentBranch(repoRoot),
            telemetryFile,
            state,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendTelemetry(telemetryFile, {
            event: "qc-repair-loop-qc-run-error",
            run_id: state.run_id,
            error: msg,
            timestamp: new Date().toISOString(),
          });
          appendForemanSymptom({
            runId: state.run_id,
            clusterId: state.cluster_id,
            code: "foreman-qc-runtime-failure",
            message: `QC run at completed-cluster trigger threw a runtime error: ${msg}`,
            evidenceRefs: [telemetryFile],
            repoRoot,
            config,
          });
          // Non-fatal: proceed to cluster-complete without repair loop.
          initialQcResult = null;
        }

        const hasFindings =
          initialQcResult !== null &&
          initialQcResult.results.some(
            (r) => r.findings.length > 0 && r.status !== "passed" && r.status !== "skipped",
          );

        // Append QC escalation symptoms for initial findings (blocking / parse failures / etc.)
        if (initialQcResult !== null && initialQcResult.results.length > 0) {
          appendQcEscalationSymptoms({
            runId: state.run_id,
            clusterId: state.cluster_id,
            qcResults: initialQcResult.results,
            afterRepair: false,
            repoRoot,
          });
        }

        if (initialQcResult !== null && hasFindings) {
          const maxRepairRounds = config.qc.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
          const priorLoopState = state.qc_repair_loop ?? null;

          // Build the repair worker dispatcher using the existing adapter + provider.
          const repairDispatcher: DispatchRepairWorkerFn = async (packet, round, manifest, signal) => {
            const repairPacketId = packet.packetId;
            const dispatchId = randomUUID();
            const repairWorkerId = `${state.run_id}:repair-${repairPacketId}:${Date.now()}`;
            const repairResultPath = join(
              repoRoot,
              ".polaris",
              "clusters",
              state.cluster_id,
              "results",
              `repair-${repairPacketId}-${dispatchId}.json`,
            );

            const workerPacket = compileRepairWorkerPacket({
              runId: state.run_id,
              clusterId: state.cluster_id,
              packetId: repairPacketId,
              branch: state.branch ?? getCurrentBranch(repoRoot),
              stateFile,
              telemetryFile,
              round,
              allowedScope: packet.allowedScope,
              prohibitedScope: packet.prohibitedScope,
              validationCommands: packet.validationCommands,
              rootCauseHint: packet.rootCauseHint,
              resultFile: repairResultPath,
              maxConcurrentWorkers,
            });

            appendTelemetry(telemetryFile, {
              event: "repair-worker-dispatched",
              run_id: state.run_id,
              cluster_id: state.cluster_id,
              packet_id: repairPacketId,
              worker_id: repairWorkerId,
              round,
              timestamp: new Date().toISOString(),
            });

            try {
              // TODO: Propagate AbortSignal to adapter.dispatch() once ExecutionAdapter
              // interface supports cancellation. Current limitation: timeout abandons the
              // Promise but doesn't terminate the spawned worker process.
              if (signal?.aborted) {
                throw signal.reason || new Error("Repair dispatch aborted");
              }
              const dispatchResult = await adapter.dispatch(workerPacket, { provider: providerName, dryRun });
              const workerSummary = parseWorkerSummary(dispatchResult.summary);
              const success = workerSummary?.status === "done";
              appendTelemetry(telemetryFile, {
                event: "repair-worker-completed",
                run_id: state.run_id,
                packet_id: repairPacketId,
                worker_id: repairWorkerId,
                round,
                status: success ? "success" : "failure",
                timestamp: new Date().toISOString(),
              });
              return {
                packetId: repairPacketId,
                status: success ? "success" : "failure",
                commitSha: workerSummary?.commit as string | undefined,
                errorMessage: success ? undefined : String(workerSummary?.error_message ?? "repair worker failed"),
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              appendTelemetry(telemetryFile, {
                event: "repair-worker-error",
                run_id: state.run_id,
                packet_id: repairPacketId,
                worker_id: repairWorkerId,
                round,
                error: msg,
                timestamp: new Date().toISOString(),
              });
              return {
                packetId: repairPacketId,
                status: "failure" as const,
                errorMessage: msg,
              };
            }
          };

          try {
            const repairLoopResult = await runQcRepairLoop({
              clusterId: state.cluster_id,
              runId: state.run_id,
              branch: state.branch ?? getCurrentBranch(repoRoot),
              repoRoot,
              telemetryFile,
              config: config.qc,
              registry: qcRegistry,
              initialQcResults: initialQcResult.results,
              dispatchRepairWorker: repairDispatcher,
              maxRounds: maxRepairRounds,
              priorLoopState,
              onStateUpdate: (loopState: QcRepairLoopState) => {
                // Persist loop state to the state file on each mutation.
                const stateWithLoop = { ...state, qc_repair_loop: loopState };
                writeStateAtomic(stateFile, stateWithLoop);
              },
            });

            state = { ...state, qc_repair_loop: repairLoopResult.loop_state };
            writeStateAtomic(stateFile, state);

            appendTelemetry(telemetryFile, {
              event: "qc-repair-loop-finished",
              run_id: state.run_id,
              outcome: repairLoopResult.outcome,
              rounds_completed: repairLoopResult.rounds_completed,
              summary: repairLoopResult.summary,
              timestamp: new Date().toISOString(),
            });

            // Append QC escalation symptoms for non-passing outcomes and post-repair findings.
            appendRepairLoopOutcomeSymptom({
              runId: state.run_id,
              clusterId: state.cluster_id,
              repairResult: repairLoopResult,
              repoRoot,
            });
            if (repairLoopResult.final_qc_results.length > 0 && repairLoopResult.rounds_completed > 0) {
              appendQcEscalationSymptoms({
                runId: state.run_id,
                clusterId: state.cluster_id,
                qcResults: repairLoopResult.final_qc_results,
                afterRepair: true,
                repoRoot,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendTelemetry(telemetryFile, {
              event: "qc-repair-loop-error",
              run_id: state.run_id,
              error: msg,
              timestamp: new Date().toISOString(),
            });
            appendForemanSymptom({
              runId: state.run_id,
              clusterId: state.cluster_id,
              code: "foreman-qc-runtime-failure",
              message: `QC repair loop threw a runtime error: ${msg}`,
              evidenceRefs: [telemetryFile],
              repoRoot,
              config,
            });
            // Non-fatal: proceed to cluster-complete.
          }
        }
      }
      // ── End QC repair loop ─────────────────────────────────────────────────

      // ── Run-health Medic consult ────────────────────────────────────────────
      // If the run recorded health symptoms and no Medic decision exists yet,
      // dispatch Medic to diagnose and optionally emit bounded treatment packets.
      if (!dryRun) {
        const runHealthReport = readRunHealthReport(state.run_id, repoRoot);
        if (runHealthReport && !isMedicGateSatisfied(runHealthReport)) {
          const maxTreatmentRounds = config.qc?.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS;
          const medicDispatchId = randomUUID();
          const medicResultPath = join(
            repoRoot,
            ".polaris",
            "clusters",
            state.cluster_id,
            "results",
            `medic-run-health-${medicDispatchId}.json`,
          );
          const medicPacket: MedicRunHealthPacket = {
            role: "medic-run-health",
            run_id: state.run_id,
            dispatch_id: medicDispatchId,
            cluster_id: state.cluster_id,
            run_health_report_path: getRunHealthReportPath(state.run_id, repoRoot),
            qc_artifact_refs: Array.from(
              new Set([
                ...runHealthReport.evidence_refs,
                ...runHealthReport.symptoms.flatMap((s) => s.evidence_refs),
              ]),
            ),
            telemetry_path: telemetryFile,
            cluster_state_path: join(
              repoRoot,
              ".polaris",
              "clusters",
              state.cluster_id,
              "state.json",
            ),
            policy_limits: { max_treatment_rounds: maxTreatmentRounds },
            result_path: medicResultPath,
            allowed_write_paths: [
              "smartdocs/medic/charts",
              ".polaris/runs",
              ".polaris/clusters",
              ".taskchain_artifacts",
            ],
            prohibited_write_paths: [],
          };

          try {
            await runMedicRunHealthConsult({
              packet: medicPacket,
              repoRoot,
              stateFile,
              telemetryFile,
              branch: state.branch ?? getCurrentBranch(repoRoot),
              validationCommands: ["npm run build", "npm test"],
              maxConcurrentWorkers,
              dryRun,
              dispatchTreatmentWorkerFn: (input) =>
                dispatchTreatmentWorker({
                  ...input,
                  repoRoot,
                  dispatch: (workerPacket) =>
                    adapter.dispatch(workerPacket, { provider: providerName }),
                }),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendTelemetry(telemetryFile, {
              event: "medic-run-health-consult-error",
              run_id: state.run_id,
              cluster_id: state.cluster_id,
              error: msg,
              timestamp: new Date().toISOString(),
            });
            appendForemanSymptom({
              runId: state.run_id,
              clusterId: state.cluster_id,
              code: "foreman-medic-runtime-failure",
              message: `Medic run-health consult threw a runtime error: ${msg}`,
              evidenceRefs: [telemetryFile],
              repoRoot,
              config,
            });
          }
        }
      }
      // ── End run-health Medic consult ───────────────────────────────────────

      // All children completed — write final state and halt
      if (!dryRun) {
        logStatus(notificationFormat, "COMPLETE");
        const clusterCompleteState = { ...state, status: "cluster-complete" as const };
        writeStateAtomic(stateFile, clusterCompleteState);
        writeStateAtomic(join(repoRoot, '.polaris', 'clusters', state.cluster_id, 'state.json'), clusterCompleteState);
        appendTelemetry(telemetryFile, {
          event: "cluster-complete",
          run_id: state.run_id,
          children_completed: state.completed_children.length,
          timestamp: new Date().toISOString(),
        });
        appendClusterCompletedLedgerEvent(repoRoot, { ...state, status: "cluster-complete" });
        if (autoFinalizeRequested) {
          appendTelemetry(telemetryFile, {
            event: "auto-finalize-requested",
            run_id: state.run_id,
            next_action: "polaris finalize run",
            timestamp: new Date().toISOString(),
          });
        }
      }
      const messageSuffix = autoFinalizeRequested
        ? " Auto-finalize handoff requested; run `polaris finalize run` to complete delivery."
        : "";
      return {
        haltReason: 'cluster-complete',
        childrenDispatched,
        message: `Cluster complete. All ${state.completed_children.length} children dispatched.${messageSuffix}`,
      };
    }

    // ── Step 02 (post-select): Analyze-drift guardrail ───────────────────
    if (!allowAnalyzeChildren && isAnalyzeChild(nextChild, state)) {
      const errMsg = [
        `ERROR: Next child ${nextChild} is an analyze issue.`,
        `Loop halted to prevent recursive analysis drift.`,
        ``,
        `To override:`,
        `  polaris.config.json → budget.allow_analyze_children: true`,
        `  or: polaris loop continue --allow-analyze-children`,
      ].join("\n");
      process.stderr.write(errMsg + "\n");
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "analyze-drift-halt",
          run_id: state.run_id,
          child_id: nextChild,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'analyze-drift',
        childrenDispatched,
        haltingChild: nextChild,
        message: errMsg,
      };
    }

    // ── Step 05 (pre-dispatch): Check budget before dispatching ─────────
    const budgetCheck = checkBudget({
      childrenCompleted: state.context_budget.children_completed,
      policy: budgetPolicy,
    });
    if (budgetCheck.status === 'exhausted') {
      // Write checkpoint before halting
      if (!dryRun) {
        writeStateAtomic(stateFile, {
          ...state,
          status: "budget-exhausted",
          step_cursor: "budget-check",
          next_open_child: nextChild,
        });
        appendTelemetry(telemetryFile, {
          event: "budget-exhausted",
          run_id: state.run_id,
          children_completed: state.context_budget.children_completed,
          next_child: nextChild,
          reason: budgetCheck.reason,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'budget-exhausted',
        childrenDispatched,
        haltingChild: nextChild,
        message: budgetCheck.reason,
      };
    }

    // ── Dispatch boundary guard ──────────────────────────────────────────────
    //
    // HARD CONSTRAINT: The parent/orchestrator MUST NOT execute child work
    // inline. If active_child is already set, a previous dispatch was not
    // properly completed — halt and require manual resolution.
    //
    // This guard also fires if the runtime somehow reached a child-execution
    // state without a dispatch event (e.g. state corruption or inline attempt).
    try {
      assertNoActiveChildBeforeDispatch(state, telemetryFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "invalid-inline-attempt",
          run_id: state.run_id,
          child_id: nextChild,
          reason: msg,
          timestamp: new Date().toISOString(),
        });
        appendForemanSymptom({
          runId: state.run_id,
          clusterId: state.cluster_id,
          code: "foreman-dispatch-boundary-repair",
          message: `Dispatch boundary violation: ${msg}`,
          evidenceRefs: [telemetryFile],
          repoRoot,
          config,
        });
      }
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: msg,
      };
    }

    // ── Child body preflight gate ────────────────────────────────────────────
    //
    // HARD GATE: Every child MUST have a resolvable body/description before
    // dispatch. Runtime state is checked first (cache); if absent, the durable
    // cluster snapshot (.polaris/clusters/<id>/clusters.json) is the fallback.
    // If neither source has a body, tell the operator to run tracker sync-in.
    {
      const cachedChildBody = state.open_children_meta?.[nextChild]?.body;
      const childBody = (cachedChildBody && cachedChildBody.trim().length > 0)
        ? cachedChildBody
        : readBodyFromClusterSnapshot(state.cluster_id, nextChild, repoRoot);
      if (!dryRun && (!childBody || childBody.trim().length === 0)) {
        const errMsg =
          `Child ${nextChild} has no body/description; cannot generate actionable packet. ` +
          `Run 'tracker sync-in ${state.cluster_id}' to populate issue body data from Linear.`;
        appendTelemetry(telemetryFile, {
          event: "preflight-body-missing",
          run_id: state.run_id,
          child_id: nextChild,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: 'preflight-failed',
          childrenDispatched,
          haltingChild: nextChild,
          message: errMsg,
        };
      }
    }

    // ── Child scope preflight gate ───────────────────────────────────────────
    //
    // HARD GATE: Every impl child MUST have a derivable allowed_scope before
    // dispatch. Scope is parsed from the child's body "## Scope" / "## Expected
    // code areas" section, with fallback to the cluster-root (parent) body.
    // Both sources check runtime state first, then the cluster snapshot.
    // A packet with empty allowed_scope would block the worker immediately —
    // fail here with a clear error instead.
    // Analyze children are exempt since they don't produce impl packets.
    {
      const cachedChildBody = state.open_children_meta?.[nextChild]?.body;
      const childBody = (cachedChildBody && cachedChildBody.trim().length > 0)
        ? cachedChildBody
        : readBodyFromClusterSnapshot(state.cluster_id, nextChild, repoRoot) ?? '';
      if (!dryRun && childBody.trim().length > 0 && !isAnalyzeChild(nextChild, state)) {
        const { scope: childScope } = parseIssueBody(childBody);
        if (childScope.length === 0) {
          // Fallback: check the cluster-root (parent) body for scope
          const cachedParentBody = state.open_children_meta?.[state.cluster_id]?.body;
          const parentBody = (cachedParentBody && cachedParentBody.trim().length > 0)
            ? cachedParentBody
            : readBodyFromClusterSnapshot(state.cluster_id, state.cluster_id, repoRoot) ?? '';
          const { scope: parentScope } = parseIssueBody(parentBody);
          if (parentScope.length === 0) {
            const errMsg =
              `Child ${nextChild} body has no scope section; cannot generate actionable packet. ` +
              `Add a "## Scope" section with explicit repo paths or globs. ` +
              `If scope is unknown, write "- TBD — BLOCKED: scope missing" and mark the issue as Blocked in Linear.`;
            appendTelemetry(telemetryFile, {
              event: "preflight-scope-missing",
              run_id: state.run_id,
              child_id: nextChild,
              timestamp: new Date().toISOString(),
            });
            return {
              haltReason: 'preflight-failed',
              childrenDispatched,
              haltingChild: nextChild,
              message: errMsg,
            };
          }
        }
      }
    }

    // ── Placeholder primary goal gate ───────────────────────────────────────
    //
    // HARD GATE (impl only): The child's ## Goal section must not be empty or
    // placeholder text. A placeholder goal means the issue was never properly
    // authored — dispatching would produce meaningless or incorrect work.
    // Analyze children are exempt since they are not implementation issues.
    {
      const cachedChildBodyForGoal = state.open_children_meta?.[nextChild]?.body;
      const childBody = (cachedChildBodyForGoal && cachedChildBodyForGoal.trim().length > 0)
        ? cachedChildBodyForGoal
        : readBodyFromClusterSnapshot(state.cluster_id, nextChild, repoRoot) ?? '';
      if (!dryRun && childBody.trim().length > 0 && !isAnalyzeChild(nextChild, state)) {
        const { goal } = parseIssueBody(childBody);
        if (isPlaceholderGoal(goal)) {
          const errMsg =
            `Child ${nextChild} body has a placeholder primary goal; cannot generate actionable packet. ` +
            `Fill in the "## Goal" section with a specific, actionable objective.`;
          appendTelemetry(telemetryFile, {
            event: "preflight-placeholder-goal",
            run_id: state.run_id,
            child_id: nextChild,
            timestamp: new Date().toISOString(),
          });
          return {
            haltReason: 'preflight-failed',
            childrenDispatched,
            haltingChild: nextChild,
            message: errMsg,
          };
        }
      }
    }

    // ── Step 03: Dispatch worker via configured adapter ──────────────────
    //
    // ADAPTER HANDOFF semantics: dispatching the worker and then continuing
    // the loop is the correct behaviour. The parent does NOT halt here.
    // The worker runs the child in an external process/subtask, writes its
    // result to current-state.json and telemetry.jsonl, then returns a
    // compact JSON summary via stdout.
    //
    // Lifecycle: register before dispatch, release after result.
    // Only one worker may be active at a time (maxConcurrentWorkers = 1).
    //
    // Record the dispatch in state BEFORE calling the adapter so that
    // dispatch_boundary.dispatch_epoch is always incremented before any
    // worker execution occurs. This ensures the "dispatched → completed"
    // transition is always verifiable from state alone.
    const dispatchId = randomUUID();
    const workerId = `${state.run_id}:${nextChild}:${Date.now()}`;
    const dispatchedAt = new Date().toISOString();
    const resultFile = childResultFilePath(state, nextChild, repoRoot, dispatchId);
    const packetPath = buildClusterArtifactPaths(repoRoot, state.cluster_id, nextChild, dispatchId).packetPath;
    mkdirSync(dirname(resultFile), { recursive: true });
    const statePreDispatch = state;
    let stateBeforeDispatch = state;
    const packet = buildPacket(
      state,
      nextChild,
      stateFile,
      telemetryFile,
      repoRoot,
      resultFile,
      maxConcurrentWorkers,
    );

    // ── Child-level QC selection ─────────────────────────────────────────────
    // Only opt-in conditions may select child-level QC. The dispatch boundary
    // below enforces that any child-level marker on the packet is valid.
    let packetWithQc: WorkerPacket & { qc_trigger?: string } = packet;
    let stateWithQcMeta = state;
    const childQcTrigger = selectChildQcTrigger(
      config.qc,
      nextChild,
      packet.instructions.allowed_scope,
      state.open_children_meta?.[nextChild]?.labels,
    );
    if (childQcTrigger) {
      packetWithQc = { ...packet, qc_trigger: childQcTrigger };
      stateWithQcMeta = {
        ...state,
        open_children_meta: {
          ...state.open_children_meta,
          [nextChild]: {
            ...(state.open_children_meta?.[nextChild] ?? {}),
            qc_trigger: childQcTrigger,
          },
        },
      };
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "qc-child-trigger-selected",
          run_id: state.run_id,
          child_id: nextChild,
          qc_trigger: childQcTrigger,
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (!dryRun) {
      try {
        assertChildQcSelectionAllowed(
          stateWithQcMeta,
          nextChild,
          config.qc,
          packet.instructions.allowed_scope,
          state.open_children_meta?.[nextChild]?.labels,
          telemetryFile,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendTelemetry(telemetryFile, {
          event: "qc-child-selection-rejected",
          run_id: state.run_id,
          child_id: nextChild,
          error: msg,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: 'worker-error',
          childrenDispatched,
          haltingChild: nextChild,
          message: msg,
        };
      }

      try {
        writePacketArtifact(packetPath, packetWithQc as WorkerPacket);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendTelemetry(telemetryFile, {
          event: "child-dispatched-error",
          run_id: state.run_id,
          child_id: nextChild,
          worker_id: workerId,
          error: `Failed to write packet artifact: ${msg}`,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: 'worker-error',
          childrenDispatched,
          haltingChild: nextChild,
          message: `Failed to write packet artifact for ${nextChild}: ${msg}`,
        };
      }

      const dispatchRecord = buildParentDispatchRecord({
        dispatchId,
        runId: state.run_id,
        clusterId: state.cluster_id,
        childId: nextChild,
        packetPath,
        resultPath: resultFile,
        provider: providerName,
        providerSelectionReason,
        providersTried,
        routingSummary,
        workerId,
        dispatchedAt,
      });
      const stateWithDispatch: LoopState = {
        ...withWorkerPoolState(
          withChildDispatchMetadata(stateWithQcMeta, nextChild, resultFile, dispatchRecord),
          maxConcurrentWorkers,
          nextSlotClaims,
        ),
        active_child: nextChild,
        step_cursor: "dispatch",
        dispatch_boundary: advanceDispatchEpoch(state.dispatch_boundary, nextChild),
      };
      writeStateAtomic(stateFile, stateWithDispatch);
      state = stateWithDispatch;
      stateBeforeDispatch = stateWithDispatch;

      try {
        await syncClusterDispatch({
          clusterId: state.cluster_id,
          childId: nextChild,
          repoRoot,
          packetPath,
          workerId,
          dispatchedAt,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        appendTelemetry(telemetryFile, {
          event: "child-dispatched-error",
          run_id: state.run_id,
          child_id: nextChild,
          worker_id: workerId,
          error: `Failed to sync cluster dispatch state: ${msg}`,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: 'worker-error',
          childrenDispatched,
          haltingChild: nextChild,
          message: `Failed to sync cluster dispatch state for ${nextChild}: ${msg}`,
        };
      }
    }

    const childrenCompletedBeforeDispatch = state.context_budget.children_completed;

    // Register the worker slot before dispatch.
    try {
      lifecycle.register(workerId, nextChild, 'impl');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: `Lifecycle slot unavailable for ${nextChild}: ${msg}`,
      };
    }

    if (!dryRun) {
      const totalChildren = state.open_children.length + state.completed_children.length;
      const childIndex = state.completed_children.length + 1;
      const selectedSlotClaim = nextSlotClaims.find((claim) => claim.child_id === nextChild);
      logStatus(notificationFormat, `RUNNING ${nextChild} (${childIndex}/${totalChildren})`);
      appendTelemetry(telemetryFile, {
        event: "child-dispatched",
        run_id: state.run_id,
        child_id: nextChild,
        worker_id: workerId,
        adapter: adapterName,
        orchestration_mode: telemetryOrchestrationMode,
        provider: providerName,
        prompt_mode: packet.prompt_mode,
        prompt_estimated_tokens: packet.prompt_metrics.estimated_tokens,
        packet_path: packetPath,
        expected_result_path: resultFile,
        dry_run: dryRun,
        selected_slot_claim: selectedSlotClaim ?? null,
        slot_claims: nextSlotClaims,
        routing_summary: routingSummary ?? null,
        timestamp: new Date().toISOString(),
      });

      emitBootstrapContextSize(telemetryFile, state.run_id, nextChild, stateFile, packet);
    }

    let dispatchResult;
    try {
      dispatchResult = await adapter.dispatch(packet, { provider: providerName, dryRun });
    } catch (err) {
      // Release slot on dispatch failure so the parent can retry or halt cleanly.
      lifecycle.release(workerId);
      const msg = err instanceof Error ? err.message : String(err);
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "child-dispatched-error",
          run_id: state.run_id,
          child_id: nextChild,
          worker_id: workerId,
          error: msg,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: `Adapter "${adapterName}" threw during dispatch of ${nextChild}: ${msg}`,
      };
    }

    // Release the lifecycle slot — worker has returned its result.
    lifecycle.release(workerId);

    // ── Step 04: Receive and validate compact worker return JSON ─────────
    let finalWorkerSummary: WorkerSummary | null = null;

    // Pre-dispatch failure: adapter returned before launching any worker.
    // No result file was written. Roll back dispatch state so the run is
    // cleanly resumable without manual `loop abort` intervention.
    if (dispatchResult.pre_dispatch_failure && !dryRun) {
      writeStateAtomic(stateFile, statePreDispatch);
      appendTelemetry(telemetryFile, {
        event: "pre-dispatch-failure",
        run_id: state.run_id,
        child_id: nextChild,
        adapter: adapterName,
        error: dispatchResult.summary ?? "adapter returned pre-dispatch failure",
        timestamp: new Date().toISOString(),
      });
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: `Adapter "${adapterName}" cannot dispatch ${nextChild}: ${dispatchResult.summary ?? "no dispatcher available"}`,
      };
    }

    // Only read the sealed result file when the adapter reports success.
    // A non-zero exit_code means the worker never produced a sealed result —
    // attempting readFileSync would cause ENOENT.
    if (dispatchResult.exit_code === 0 && !dryRun) {
      try {
        const sealedFileContent = readFileSync(packet.result_file_contract.result_file, 'utf-8');
        const parsed = JSON.parse(sealedFileContent) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error(`Sealed result file has unexpected shape (expected object, got ${Array.isArray(parsed) ? 'array' : typeof parsed})`);
        }
        const sealedResult = parsed as Record<string, unknown>;
        // Translate SealedWorkerResult status values to WorkerSummary status values.
        // SealedWorkerResult uses "success"/"failure"; WorkerSummary uses "done"/"failed".
        if (sealedResult['status'] === 'success') {
          sealedResult['status'] = 'done';
        } else if (sealedResult['status'] === 'failure') {
          sealedResult['status'] = 'failed';
        }
        finalWorkerSummary = sealedResult as WorkerSummary;

        // ── Ingest worker-reported run-health symptoms ────────────────────────
        // Only process when worker reports at least one symptom. Errors are
        // logged to telemetry but never block the run — symptom reporting is
        // advisory, not a gate.
        const rawSymptoms = sealedResult['run_health_symptoms'];
        if (!dryRun && Array.isArray(rawSymptoms) && rawSymptoms.length > 0) {
          const dispatchRecord = state.open_children_meta?.[nextChild]?.dispatch_record;
          try {
            upsertWorkerSymptoms({
              runId: state.run_id,
              clusterId: state.cluster_id,
              childId: nextChild,
              workerId: dispatchRecord?.worker_id,
              provider: dispatchRecord?.provider,
              symptoms: rawSymptoms as WorkerRunHealthSymptom[],
              repoRoot,
            });
            appendTelemetry(telemetryFile, {
              event: "run-health-symptoms-ingested",
              run_id: state.run_id,
              child_id: nextChild,
              symptom_count: rawSymptoms.length,
              timestamp: new Date().toISOString(),
            });
          } catch (symptomErr) {
            const symptomMsg = symptomErr instanceof Error ? symptomErr.message : String(symptomErr);
            appendTelemetry(telemetryFile, {
              event: "run-health-ingest-error",
              run_id: state.run_id,
              child_id: nextChild,
              error: symptomMsg,
              timestamp: new Date().toISOString(),
            });
            // ponytail: consider surfacing ingest errors to operator via logStatus in a future pass
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (!dryRun) {
          appendTelemetry(telemetryFile, {
            event: "sealed-result-read-error",
            run_id: state.run_id,
            child_id: nextChild,
            error: msg,
            result_file: packet.result_file_contract.result_file,
            timestamp: new Date().toISOString(),
          });
          appendForemanSymptom({
            runId: state.run_id,
            clusterId: state.cluster_id,
            code: "foreman-packet-repair",
            message: `Failed to read sealed result file for ${nextChild}: ${msg}`,
            evidenceRefs: [telemetryFile],
            repoRoot,
            config,
          });
        }
        return {
          haltReason: 'worker-error',
          childrenDispatched,
          haltingChild: nextChild,
          message: `Failed to read sealed result file for ${nextChild}: ${msg}`,
        };
      }
    } else {
      finalWorkerSummary = parseWorkerSummary(dispatchResult.summary);
    }
    
    const workerStatus = finalWorkerSummary?.status ?? (dispatchResult.exit_code === 0 ? 'done' : 'error');

    // Verify active_child or child_id matches if present in worker summary
    const summaryAsRecord = finalWorkerSummary as Record<string, unknown> | null;
    const summaryChild = summaryAsRecord?.['active_child'] ?? summaryAsRecord?.['child_id'];
    if (summaryChild !== undefined && summaryChild !== nextChild) {
      const errMsg = `Worker returned mismatched child identifier: expected ${nextChild}, got ${String(summaryChild)}`;
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "child-error",
          run_id: state.run_id,
          child_id: nextChild,
          error: errMsg,
          timestamp: new Date().toISOString(),
        });
        appendForemanSymptom({
          runId: state.run_id,
          clusterId: state.cluster_id,
          code: "foreman-wrong-run-telemetry",
          message: errMsg,
          evidenceRefs: [telemetryFile],
          repoRoot,
          config,
        });
      }
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: errMsg,
      };
    }

    if (workerStatus === 'blocked') {
      const blockerMsg =
        ((finalWorkerSummary as Record<string, unknown> | null)?.['blocker'] as string | undefined) ??
        dispatchResult.summary ??
        `Worker reported blocked for ${nextChild}`;
      if (!dryRun) {
        logStatus(notificationFormat, `BLOCKED ${nextChild}: ${blockerMsg.replace(/\n/g, ' ')}`);
        appendTelemetry(telemetryFile, {
          event: "child-blocked",
          run_id: state.run_id,
          child_id: nextChild,
          blocker: blockerMsg.replace(/\n/g, ' '),
          timestamp: new Date().toISOString(),
        });
        // Write checkpoint with blocker information
        writeStateAtomic(stateFile, {
          ...state,
          status: "blocked",
          step_cursor: "blocked",
          blocker: {
            reason: typeof blockerMsg === 'string' ? blockerMsg : String(blockerMsg),
            child_id: nextChild,
            timestamp: new Date().toISOString(),
            resolved: false,
          },
        });

        // ── Apply lifecycle transition for child-triage-required event ─────────
        // This is fire-and-forget: must not block on tracker mutations.
        // Errors are logged to telemetry but do not fail the halt.
        let adapter;
        try {
          adapter = loadTrackerAdapter(config);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          appendTelemetry(telemetryFile, {
            event: "lifecycle-transition-error",
            run_id: state.run_id,
            child_id: nextChild,
            transition_event: "child-triage-required",
            error: `Failed to load tracker adapter: ${errorMsg}`,
            timestamp: new Date().toISOString(),
          });
          adapter = null;
        }

        const lifecyclePolicy = config.tracker?.lifecyclePolicy;

        if (adapter || lifecyclePolicy) {
          try {
            const transitionService = new LifecycleTransitionService();
            transitionService
              .applyTransitionSafe({
                adapter,
                policy: lifecyclePolicy,
                taskId: nextChild,
                event: "child-triage-required",
                evidence: {
                  error: blockerMsg,
                },
                timestamp: new Date().toISOString(),
              })
              .then((result) => {
                appendTelemetry(telemetryFile, {
                  event: "lifecycle-transition-attempt",
                  run_id: state.run_id,
                  child_id: nextChild,
                  transition_event: result.event,
                  target_state: result.targetState,
                  applied: result.applied,
                  skipped: result.skipped,
                  skip_reason: result.skipReason,
                  error: result.error,
                  timestamp: result.timestamp,
                });
              })
              .catch((err) => {
                const errorMsg = err instanceof Error ? err.message : String(err);
                appendTelemetry(telemetryFile, {
                  event: "lifecycle-transition-error",
                  run_id: state.run_id,
                  child_id: nextChild,
                  transition_event: "child-triage-required",
                  error: errorMsg,
                  timestamp: new Date().toISOString(),
                });
              });
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            appendTelemetry(telemetryFile, {
              event: "lifecycle-transition-error",
              run_id: state.run_id,
              child_id: nextChild,
              transition_event: "child-triage-required",
              error: `Failed to create lifecycle transition service: ${errorMsg}`,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
      return {
        haltReason: 'blocked',
        childrenDispatched,
        haltingChild: nextChild,
        message: `Child ${nextChild} is blocked: ${typeof blockerMsg === 'string' ? blockerMsg : String(blockerMsg)}`,
      };
    }

    // 'failed' is the CompactReturn terminal failure status; 'error' is the adapter-level status.
    // Both map to worker-error halt — the exit_code check catches exit=1 from runWorker().
    if (workerStatus === 'error' || workerStatus === 'failed' || dispatchResult.exit_code !== 0) {
      const errMsg = dispatchResult.summary ?? `Worker exited with code ${dispatchResult.exit_code}`;
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "child-error",
          run_id: state.run_id,
          child_id: nextChild,
          exit_code: dispatchResult.exit_code,
          summary: errMsg,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: `Worker for ${nextChild} failed (exit ${dispatchResult.exit_code}): ${errMsg}`,
      };
    }

    // Only treat 'done' as successful completion; treat unknown statuses as errors
    if (workerStatus !== 'done') {
      const errMsg = `Worker returned unexpected status: ${workerStatus}`;
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "child-error",
          run_id: state.run_id,
          child_id: nextChild,
          error: errMsg,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: `Worker for ${nextChild} returned unexpected status: ${workerStatus}`,
      };
    }

    // Worker completed successfully — reload state from disk before advancing
    // The worker may have updated current-state.json; reload to avoid clobbering
    let reloadedStateValid = false;
    try {
      const reloadedState = readState(stateFile);
      const reloadErrors = validateState(reloadedState);
      if (reloadErrors.length > 0) {
        const errMsg = `State file corrupted after worker execution:\n${reloadErrors.join("\n")}`;
        if (!dryRun && adapterName === "terminal-cli") {
          appendTelemetry(telemetryFile, {
            event: "state-reload-fallback",
            run_id: state.run_id,
            child_id: nextChild,
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
          appendForemanSymptom({
            runId: state.run_id,
            clusterId: state.cluster_id,
            code: "foreman-state-repair",
            message: `State file validation failed after worker execution; using pre-dispatch fallback: ${errMsg}`,
            evidenceRefs: [telemetryFile],
            repoRoot,
            config,
          });
          state = stateBeforeDispatch;
        } else if (!dryRun) {
          appendTelemetry(telemetryFile, {
            event: "state-reload-error",
            run_id: state.run_id,
            child_id: nextChild,
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
          return {
            haltReason: 'state-invalid',
            childrenDispatched,
            haltingChild: nextChild,
            message: errMsg,
          };
        }
      } else {
        state = reloadedState;
        reloadedStateValid = true;
        // Flush bodies from worker-updated state to clusters.json before any stripping
        if (!dryRun) {
          flushBodiesToClusterSnapshot(state, repoRoot);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `Failed to reload state after worker execution: ${msg}`;
      if (!dryRun && adapterName === "terminal-cli") {
        appendTelemetry(telemetryFile, {
          event: "state-reload-fallback",
          run_id: state.run_id,
          child_id: nextChild,
          error: errMsg,
          timestamp: new Date().toISOString(),
        });
        appendForemanSymptom({
          runId: state.run_id,
          clusterId: state.cluster_id,
          code: "foreman-state-repair",
          message: `State reload threw after worker execution; using pre-dispatch fallback: ${errMsg}`,
          evidenceRefs: [telemetryFile],
          repoRoot,
          config,
        });
        state = stateBeforeDispatch;
      } else if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "state-reload-error",
          run_id: state.run_id,
          child_id: nextChild,
          error: errMsg,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: 'state-invalid',
          childrenDispatched,
          haltingChild: nextChild,
          message: errMsg,
        };
      }
    }

    const workerWroteCompletion =
      reloadedStateValid &&
      (state.completed_children.includes(nextChild) ||
        state.context_budget.children_completed > childrenCompletedBeforeDispatch);

    const lastCommit =
      (finalWorkerSummary as Record<string, unknown>)?.['commit'] as string | undefined ??
      (finalWorkerSummary as Record<string, unknown>)?.['commit_hash'] as string | undefined;

    const validationSummary =
      (finalWorkerSummary as Record<string, unknown>)?.['validation'] ??
      (finalWorkerSummary as Record<string, unknown>)?.['validation_summary'];
    const dispatchRecord = state.open_children_meta?.[nextChild]?.dispatch_record;
    const providerUsed =
      ((finalWorkerSummary as Record<string, unknown>)?.['provider'] as string | undefined) ??
      ((finalWorkerSummary as Record<string, unknown>)?.['provider_used'] as string | undefined) ??
      dispatchRecord?.provider ??
      null;
    const modelUsed =
      ((finalWorkerSummary as Record<string, unknown>)?.['model'] as string | undefined) ??
      ((finalWorkerSummary as Record<string, unknown>)?.['model_used'] as string | undefined) ??
      null;

    if (!dryRun && workerStatus === 'done' && (!lastCommit || lastCommit.trim().length === 0)) {
      const errMsg = `Worker reported done for ${nextChild} without commit evidence`;
      appendTelemetry(telemetryFile, {
        event: "child-error",
        run_id: state.run_id,
        child_id: nextChild,
        error: errMsg,
        result_file: packet.result_file_contract.result_file,
        timestamp: new Date().toISOString(),
      });
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: errMsg,
      };
    }

    // ── Artifact-only commit gate ────────────────────────────────────────────
    //
    // HARD GATE: A worker commit that touches only Polaris artifact files
    // (.polaris/**, .taskchain_artifacts/**) indicates no real implementation
    // work was done — reject it to prevent phantom completions.
    // Uses getCommitFiles from options for testability; defaults to a git-backed
    // implementation that throws when the commit cannot be resolved (fail closed).
    let commitFiles: string[] | null = null;
    if (!dryRun && workerStatus === 'done' && lastCommit && lastCommit.trim().length > 0) {
      const getFiles = options.getCommitFiles ?? defaultGetCommitFiles;
      try {
        commitFiles = getFiles(lastCommit, repoRoot);
        if (workerWroteCompletion && commitFiles === null) {
          const errMsg = `Cannot verify worker commit ${lastCommit} for ${nextChild}: commit does not resolve to a git object`;
          appendTelemetry(telemetryFile, {
            event: "child-error",
            run_id: state.run_id,
            child_id: nextChild,
            error: errMsg,
            commit: lastCommit,
            timestamp: new Date().toISOString(),
          });
          return {
            haltReason: 'worker-error',
            childrenDispatched,
            haltingChild: nextChild,
            message: errMsg,
          };
        }
        if (commitFiles !== null) {
          const nonArtifact = commitFiles.filter(
            (f) => classifyArtifactPath(f, state.cluster_id) === 'non-artifact',
          );
          if (nonArtifact.length === 0) {
            const errMsg = `Worker commit ${lastCommit} for ${nextChild} contains only artifact files; no implementation evidence found`;
            appendTelemetry(telemetryFile, {
              event: "child-error",
              run_id: state.run_id,
              child_id: nextChild,
              error: errMsg,
              commit: lastCommit,
              timestamp: new Date().toISOString(),
            });
            return {
              haltReason: 'worker-error',
              childrenDispatched,
              haltingChild: nextChild,
              message: errMsg,
            };
          }
        }
        // null → skip check (fail-open for unresolvable commits)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errMsg = `Cannot verify worker commit ${lastCommit} for ${nextChild}: ${msg}`;
        appendTelemetry(telemetryFile, {
          event: "child-error",
          run_id: state.run_id,
          child_id: nextChild,
          error: errMsg,
          commit: lastCommit,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: 'worker-error',
          childrenDispatched,
          haltingChild: nextChild,
          message: errMsg,
        };
      }
    }

    // workerStatus === "done" has already been validated upstream.
    // Build the durable Role Evidence Contract for this completed child.
    const nextRecommendedAction: WorkerResultContract['next_recommended_action'] =
      summaryAsRecord?.['next_recommended_action'] === 'continue' ||
      summaryAsRecord?.['next_recommended_action'] === 'stop' ||
      summaryAsRecord?.['next_recommended_action'] === 'investigate'
        ? summaryAsRecord['next_recommended_action'] as WorkerResultContract['next_recommended_action']
        : 'continue';

    const workerResult: WorkerResultContract = buildWorkerResultContract({
      state,
      childId: nextChild,
      resultFile: packet.result_file_contract.result_file,
      telemetryFile,
      lastCommit: lastCommit ?? null,
      validation: validationSummary,
      packetHash: computePacketHashFromPath(packetPath),
      status: 'done',
      nextRecommendedAction,
      resultData: summaryAsRecord?.['result_data'] as Record<string, unknown> | undefined,
    });

    // If the reloaded state already reflects the completed child,
    // the worker owns the completion checkpoint and the parent
    // must not rewrite the open/closed lists, but it still records the
    // Role Evidence Contract so scoring can consume it later.
    if (!workerWroteCompletion) {
      // ── Dispatch boundary: verify dispatch happened before advancing ──────
      // The parent dispatched via adapter, so dispatch_boundary should show
      // dispatch_epoch > continue_epoch. If not, the state is inconsistent
      // and we must not complete the child (it would be inline completion).
      if (!dryRun) {
        try {
          assertDispatchedBeforeCompletion(state, nextChild, telemetryFile);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          appendTelemetry(telemetryFile, {
            event: "illegal-state-transition",
            run_id: state.run_id,
            child_id: nextChild,
            error: msg,
            timestamp: new Date().toISOString(),
          });
          return {
            haltReason: 'worker-error',
            childrenDispatched,
            haltingChild: nextChild,
            message: msg,
          };
        }
      }

      // Advance state, including continue_epoch to match the consumed dispatch
      const advanced = advanceState(state, nextChild, lastCommit);
      state = pruneWorkerPoolClaimsForChild({
        ...advanced,
        dispatch_boundary: advanceContinueEpoch(state.dispatch_boundary),
        completed_children_results: {
          ...advanced.completed_children_results,
          [nextChild]: workerResult,
        },
      }, nextChild);
      childrenDispatched += 1;
      // Worker did not write its own completion — orchestrator fills the gap.
      if (!dryRun) {
        writeStateAtomic(stateFile, state);
      }
    } else {
      // Worker wrote its own completion — advance continue_epoch to stay in sync.
      // The worker does not manage dispatch_boundary, so the parent must do it.
      state = pruneWorkerPoolClaimsForChild({
        ...state,
        dispatch_boundary: advanceContinueEpoch(state.dispatch_boundary),
        completed_children_results: {
          ...state.completed_children_results,
          [nextChild]: workerResult,
        },
      }, nextChild);
      childrenDispatched += 1;
      if (!dryRun) {
        writeStateAtomic(stateFile, state);
      }
    }

    // Orchestrator checkpoint event — always emitted after a successful child.
    if (!dryRun) {
      const commitSuffix = lastCommit && lastCommit.length > 0 ? ` (commit: ${lastCommit})` : "";
      try {
        const synced = await syncClusterCompletion({
          clusterId: state.cluster_id,
          childId: nextChild,
          repoRoot,
          resultFile: packet.result_file_contract.result_file,
          validationSummary,
          lastCommit,
        });
        if (!synced) {
          appendTelemetry(telemetryFile, {
            event: "cluster-state-sync-skipped",
            run_id: state.run_id,
            child_id: nextChild,
            reason: "no cluster state found",
            timestamp: new Date().toISOString(),
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        appendTelemetry(telemetryFile, {
          event: "cluster-state-sync-error",
          run_id: state.run_id,
          child_id: nextChild,
          error: message,
          timestamp: new Date().toISOString(),
        });
        return {
          haltReason: "state-invalid",
          childrenDispatched,
          haltingChild: nextChild,
          message: `Failed to sync cluster-state.json for ${nextChild}: ${message}`,
        };
      }
      logStatus(notificationFormat, `COMPLETE ${nextChild}${commitSuffix}`);
      // Compute elapsed_seconds from dispatch_record.dispatched_at if available
      const dispatchedAt = state.open_children_meta?.[nextChild]?.dispatch_record?.dispatched_at;
      const elapsedSeconds = dispatchedAt
        ? Math.floor((Date.now() - new Date(dispatchedAt).getTime()) / 1000)
        : undefined;
      const telemetryEvent: Record<string, unknown> = {
        event: "child-complete",
        run_id: state.run_id,
        child_id: nextChild,
        children_completed: state.context_budget.children_completed,
        validation_summary: validationSummary,
        completion_status: workerStatus,
        commit_hash: lastCommit,
        commit_files: commitFiles,
        dispatch_id: dispatchRecord?.dispatch_id,
        provider: providerUsed,
        model: modelUsed,
        router_selection_reason: dispatchRecord?.provider_selection_reason,
        providers_tried: dispatchRecord?.providers_tried,
        routing_summary: dispatchRecord?.routing_summary ?? null,
        timestamp: new Date().toISOString(),
      };
      if (elapsedSeconds !== undefined) {
        telemetryEvent.elapsed_seconds = elapsedSeconds;
      }
      appendTelemetry(telemetryFile, telemetryEvent);
      appendChildCompletedLedgerEvent(repoRoot, state, nextChild, lastCommit ?? null, validationSummary, {
        dispatchId: dispatchRecord?.dispatch_id,
        provider: providerUsed,
        model: modelUsed,
        elapsedSeconds,
        commitFiles,
        completionStatus: workerStatus,
        routerSelectionReason: dispatchRecord?.provider_selection_reason,
        providersTried: dispatchRecord?.providers_tried,
        routingSummary: dispatchRecord?.routing_summary,
      });
    }

    if (orchestrationMode === 'supervised') {
      return {
        haltReason: 'supervised-mode-child-complete',
        childrenDispatched,
        message: `Child ${nextChild} complete. Re-run to continue.`,
      };
    }

    // ── Step 05 (post-dispatch): Re-check budget before next iteration ───
    // Skip when open_children is empty: the cluster is complete and the
    // top-of-loop nextChild === null path handles cluster-complete and QC
    // repair-loop. Halting here would bypass QC repair on final-child completion.
    if (state.open_children.length > 0) {
      const postBudgetCheck = checkBudget({
        childrenCompleted: state.context_budget.children_completed,
        lastChildStatus: workerStatus,
        policy: budgetPolicy,
      });
      if (postBudgetCheck.status === 'exhausted') {
        const nextPending = state.open_children[0] ?? null;
        if (!dryRun) {
          writeStateAtomic(stateFile, {
            ...state,
            status: "budget-exhausted",
            step_cursor: "budget-check",
            next_open_child: nextPending,
          });
          appendTelemetry(telemetryFile, {
            event: "budget-exhausted",
            run_id: state.run_id,
            children_completed: state.context_budget.children_completed,
            next_child: nextPending,
            reason: postBudgetCheck.reason,
            timestamp: new Date().toISOString(),
          });
        }
        return {
          haltReason: 'budget-exhausted',
          childrenDispatched,
          haltingChild: nextPending ?? undefined,
          message: postBudgetCheck.reason,
        };
      }
    }

    // ── Step 06: CONTINUE (back to step 02) ─────────────────────────────
  }
}
