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

import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { readState, validateState, writeStateAtomic, type LoopState } from "./checkpoint.js";
import { createAdapter } from "./adapters/registry.js";
import type { BootstrapPacket, WorkerSummary } from "./adapters/types.js";
import { checkBudget, policyFromConfig } from "./budget.js";
import { loadConfig } from "../config/loader.js";
import { WorkerLifecycleManager } from "./lifecycle.js";
import { compileImplPacket, type WorkerPacket } from "./worker-packet.js";
import { selectPromptMode } from "./worker-prompt.js";
import { execFileSync } from "node:child_process";
import {
  INLINE_EXECUTION_ERROR,
  assertNoActiveChildBeforeDispatch,
  assertDispatchedBeforeCompletion,
  advanceDispatchEpoch,
  advanceContinueEpoch,
} from "./dispatch-boundary.js";
import { assertBootstrapSeal } from "./run-bootstrap.js";
import {
  DEFAULT_LEDGER_PATH,
  LedgerWriter,
  type LedgerRunType,
  type RunStartedEvent,
} from "./ledger.js";

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
}

export type ParentLoopHaltReason =
  | 'cluster-complete' // All children done
  | 'budget-exhausted' // Budget cap reached
  | 'blocked' // A child reported a blocker
  | 'worker-error' // Worker returned a non-zero exit code or error status
  | 'state-invalid' // current-state.json failed validation
  | 'analyze-parent' // Cluster root is an ANALYZE issue
  | 'analyze-drift' // Next child is an analyze issue and allow_analyze_children is false
  | 'supervised-mode-child-complete'; // Child completed in supervised mode

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
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
  return join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
}

/**
 * Select the next open child that is not Done/blocked.
 * Returns null when all children are completed.
 */
function selectNextChild(state: LoopState): string | null {
  return state.open_children[0] ?? null;
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

/**
 * Build a compiled WorkerPacket for impl dispatch.
 * Workers receive pre-baked instructions — no skill re-ingestion required.
 */
function buildPacket(
  state: LoopState,
  activeChild: string,
  stateFile: string,
  telemetryFile: string,
  repoRoot: string,
): WorkerPacket {
  const branch = state.branch ?? getCurrentBranch(repoRoot);

  const childMeta = state.open_children_meta?.[activeChild];
  const issueContext = childMeta
    ? {
        id: activeChild,
        title: childMeta.title ?? activeChild,
        key_requirements: [],
      }
    : undefined;

  const promptMode = selectPromptMode(activeChild, state);

  return compileImplPacket({
    runId: state.run_id,
    clusterId: state.cluster_id,
    childId: activeChild,
    branch,
    stateFile: canonicalPath(stateFile),
    telemetryFile,
    issueContext,
    maxConcurrentWorkers: 1,
    promptMode,
    resultFile: childMeta?.result_file,
  });
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
  const providerName =
    adapterName === "agent-subtask"
      ? "agent-subtask"
      : options.provider ??
        config.execution?.rotation?.[0] ??
        Object.keys(config.execution?.providers ?? {})[0] ??
        "default";

  const executionConfig =
    adapterName === "agent-subtask"
      ? { ...(config.execution ?? { providers: {} }), adapter: "agent-subtask" }
      : config.execution ?? { adapter: adapterName, providers: {} };
  const adapter = createAdapter(adapterName, executionConfig);
  const budgetPolicy = policyFromConfig(state.context_budget, config.budget);
  const allowAnalyzeChildren = allowAnalyzeChildrenFlag || (config.budget?.allow_analyze_children === true);
  const telemetryFile = resolveTelemetryFile(state, repoRoot);
  let childrenDispatched = 0;

  // ── Lifecycle manager: enforce one-active-worker policy ─────────────────
  // forceReleaseAll() clears any orphaned registrations from a previous
  // crashed session. Registrations are session-memory only; they are not
  // persisted to disk, so a fresh loop start always begins clean.
  const lifecycle = new WorkerLifecycleManager(1);
  lifecycle.forceReleaseAll();

  // ── Main dispatch loop ───────────────────────────────────────────────────
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Step 02: Select next open child ─────────────────────────────────
    const nextChild = selectNextChild(state);

    if (nextChild === null) {
      const autoFinalizeRequested = orchestrationMode === "auto" && config.orchestration?.auto_finalize === true;
      // All children completed — write final state and halt
      if (!dryRun) {
        logStatus(notificationFormat, "COMPLETE");
        writeStateAtomic(stateFile, { ...state, status: "cluster-complete" });
        appendTelemetry(telemetryFile, {
          event: "cluster-complete",
          run_id: state.run_id,
          children_completed: state.completed_children.length,
          timestamp: new Date().toISOString(),
        });
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
      }
      return {
        haltReason: 'worker-error',
        childrenDispatched,
        haltingChild: nextChild,
        message: msg,
      };
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
    if (!dryRun) {
      const stateWithDispatch: LoopState = {
        ...state,
        active_child: nextChild,
        step_cursor: "dispatch",
        dispatch_boundary: advanceDispatchEpoch(state.dispatch_boundary, nextChild),
      };
      writeStateAtomic(stateFile, stateWithDispatch);
      state = stateWithDispatch;
    }

    const packet = buildPacket(state, nextChild, stateFile, telemetryFile, repoRoot);
    const childrenCompletedBeforeDispatch = state.context_budget.children_completed;

    // Register the worker slot before dispatch.
    const workerId = `${state.run_id}:${nextChild}:${Date.now()}`;
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
      logStatus(notificationFormat, `DISPATCH ${nextChild}`);
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
        dry_run: dryRun,
        timestamp: new Date().toISOString(),
      });
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
    let sealedFileContent: string | undefined;

    if (packet.result_file_contract?.result_file && !dryRun) {
      try {
        sealedFileContent = readFileSync(packet.result_file_contract.result_file, 'utf-8');
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
    try {
      const reloadedState = readState(stateFile);
      const reloadErrors = validateState(reloadedState);
      if (reloadErrors.length > 0) {
        const errMsg = `State file corrupted after worker execution:\n${reloadErrors.join("\n")}`;
        if (!dryRun) {
          appendTelemetry(telemetryFile, {
            event: "state-reload-error",
            run_id: state.run_id,
            child_id: nextChild,
            error: errMsg,
            timestamp: new Date().toISOString(),
          });
        }
        return {
          haltReason: 'state-invalid',
          childrenDispatched,
          haltingChild: nextChild,
          message: errMsg,
        };
      }
      state = reloadedState;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errMsg = `Failed to reload state after worker execution: ${msg}`;
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "state-reload-error",
          run_id: state.run_id,
          child_id: nextChild,
          error: errMsg,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'state-invalid',
        childrenDispatched,
        haltingChild: nextChild,
        message: errMsg,
      };
    }

    const lastCommit =
      (finalWorkerSummary as Record<string, unknown>)?.['commit'] as string | undefined ??
      (finalWorkerSummary as Record<string, unknown>)?.['commit_hash'] as string | undefined;

    const validationSummary = (finalWorkerSummary as Record<string, unknown>)?.['validation'];

    // workerStatus === "done" has already been validated upstream.
    // If the reloaded state already reflects the completed child,
    // the worker owns the completion checkpoint and the parent
    // must not rewrite it.
    const workerWroteCompletion =
      state.completed_children.includes(nextChild) ||
      state.context_budget.children_completed > childrenCompletedBeforeDispatch;

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
      state = {
        ...advanced,
        dispatch_boundary: advanceContinueEpoch(state.dispatch_boundary),
      };
      childrenDispatched += 1;
      // Worker did not write its own completion — orchestrator fills the gap.
      if (!dryRun) {
        writeStateAtomic(stateFile, state);
      }
    } else {
      // Worker wrote its own completion — advance continue_epoch to stay in sync.
      // The worker does not manage dispatch_boundary, so the parent must do it.
      state = {
        ...state,
        dispatch_boundary: advanceContinueEpoch(state.dispatch_boundary),
      };
      childrenDispatched += 1;
      if (!dryRun) {
        writeStateAtomic(stateFile, state);
      }
    }

    // Orchestrator checkpoint event — always emitted after a successful child.
    if (!dryRun) {
      const commitSuffix = lastCommit && lastCommit.length > 0 ? ` (commit: ${lastCommit})` : "";
      logStatus(notificationFormat, `COMPLETE ${nextChild}${commitSuffix}`);
      appendTelemetry(telemetryFile, {
        event: "child-complete",
        run_id: state.run_id,
        child_id: nextChild,
        children_completed: state.context_budget.children_completed,
        validation_summary: validationSummary,
        commit_hash: lastCommit,
        timestamp: new Date().toISOString(),
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

    // ── Step 06: CONTINUE (back to step 02) ─────────────────────────────
  }
}
