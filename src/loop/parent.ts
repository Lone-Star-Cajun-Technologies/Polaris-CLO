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

import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { readState, validateState, writeStateAtomic, type LoopState } from "./checkpoint.js";
import { createAdapter } from "./adapters/registry.js";
import type { BootstrapPacket, WorkerSummary } from "./adapters/types.js";
import { checkBudget, policyFromConfig } from "./budget.js";
import { loadConfig } from "../config/loader.js";

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
  | 'cluster-complete'     // All children done
  | 'budget-exhausted'     // Budget cap reached
  | 'blocked'              // A child reported a blocker
  | 'worker-error'         // Worker returned a non-zero exit code or error status
  | 'state-invalid'        // current-state.json failed validation
  | 'analyze-parent'       // Cluster root is an ANALYZE issue
  | 'analyze-drift';       // Next child is an analyze issue and allow_analyze_children is false

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

/**
 * Build a bootstrap packet from state and the selected child.
 */
function buildPacket(
  state: LoopState,
  activeChild: string,
  stateFile: string,
  telemetryFile: string,
): BootstrapPacket {
  return {
    schema_version: state.schema_version,
    run_id: state.run_id,
    cluster_id: state.cluster_id,
    active_child: activeChild,
    // Normalize to real path so the worker gets a canonical, symlink-free path
    // (important on macOS where tmpdir() returns /var/... but resolves to /private/var/...).
    state_file: (() => { try { return realpathSync(stateFile); } catch { return stateFile; } })(),
    telemetry_file: telemetryFile,
    context: {
      skill: state.skill,
      branch: (state as unknown as Record<string, unknown>)["branch"],
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

  // Load config for adapter and provider resolution
  const config = loadConfig(repoRoot);
  const adapterName = options.adapter ?? config.execution?.adapter ?? "terminal-cli";
  const providerName =
    options.provider ??
    config.execution?.rotation?.[0] ??
    Object.keys(config.execution?.providers ?? {})[0] ??
    "default";

  const adapter = createAdapter(adapterName, config.execution ?? { adapter: adapterName, providers: {} });
  const budgetPolicy = policyFromConfig(state.context_budget, config.budget);
  const allowAnalyzeChildren = allowAnalyzeChildrenFlag || (config.budget?.allow_analyze_children === true);
  const telemetryFile = resolveTelemetryFile(state, repoRoot);
  let childrenDispatched = 0;

  // ── Main dispatch loop ───────────────────────────────────────────────────
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Step 02: Select next open child ─────────────────────────────────
    const nextChild = selectNextChild(state);

    if (nextChild === null) {
      // All children completed — write final state and halt
      if (!dryRun) {
        writeStateAtomic(stateFile, { ...state, status: "cluster-complete" });
        appendTelemetry(telemetryFile, {
          event: "cluster-complete",
          run_id: state.run_id,
          children_completed: state.completed_children.length,
          timestamp: new Date().toISOString(),
        });
      }
      return {
        haltReason: 'cluster-complete',
        childrenDispatched,
        message: `Cluster complete. All ${state.completed_children.length} children dispatched.`,
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

    // ── Step 03: Dispatch worker via configured adapter ──────────────────
    //
    // ADAPTER HANDOFF semantics: dispatching the worker and then continuing
    // the loop is the correct behaviour. The parent does NOT halt here.
    // The worker runs the child in an external process/subtask, writes its
    // result to current-state.json and telemetry.jsonl, then returns a
    // compact JSON summary via stdout.

    const packet = buildPacket(state, nextChild, stateFile, telemetryFile);
    const childrenCompletedBeforeDispatch = state.context_budget.children_completed;

    if (!dryRun) {
      appendTelemetry(telemetryFile, {
        event: "child-dispatch",
        run_id: state.run_id,
        child_id: nextChild,
        adapter: adapterName,
        provider: providerName,
        dry_run: dryRun,
        timestamp: new Date().toISOString(),
      });
    }

    let dispatchResult;
    try {
      dispatchResult = await adapter.dispatch(packet, { provider: providerName, dryRun });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "child-dispatch-error",
          run_id: state.run_id,
          child_id: nextChild,
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

    // ── Step 04: Receive and validate compact worker return JSON ─────────
    const workerSummary = parseWorkerSummary(dispatchResult.summary);
    const workerStatus = workerSummary?.status ?? (dispatchResult.exit_code === 0 ? 'done' : 'error');

    // Verify child_id matches if present in worker summary
    if (workerSummary && 'child_id' in workerSummary && workerSummary.child_id !== nextChild) {
      const errMsg = `Worker returned mismatched child_id: expected ${nextChild}, got ${workerSummary.child_id}`;
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
        ((workerSummary as Record<string, unknown> | null)?.['blocker'] as string | undefined) ??
        dispatchResult.summary ??
        `Worker reported blocked for ${nextChild}`;
      if (!dryRun) {
        appendTelemetry(telemetryFile, {
          event: "child-blocked",
          run_id: state.run_id,
          child_id: nextChild,
          blocker: blockerMsg,
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

    if (workerStatus === 'error' || dispatchResult.exit_code !== 0) {
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
      (workerSummary as Record<string, unknown>)?.['commit'] as string | undefined ??
      (workerSummary as Record<string, unknown>)?.['commit_hash'] as string | undefined;

    const childAlreadyRecorded =
      state.completed_children.includes(nextChild) ||
      state.context_budget.children_completed > childrenCompletedBeforeDispatch;

    if (!childAlreadyRecorded) {
      state = advanceState(state, nextChild, lastCommit);
      childrenDispatched += 1;
    }

    // Persist updated state after each successful child
    if (!dryRun) {
      writeStateAtomic(stateFile, state);

      appendTelemetry(telemetryFile, {
        event: "child-complete",
        run_id: state.run_id,
        child_id: nextChild,
        children_completed: state.context_budget.children_completed,
        timestamp: new Date().toISOString(),
      });
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
