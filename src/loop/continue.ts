import { join, isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readClusterStateSync, writeClusterStateSync } from "../cluster-state/store.js";
import { verifyChildCommitCustody } from "./git-custody.js";
import type { ClusterState, ChildState, ValidationResult } from "../cluster-state/types.js";
import {
  readState,
  validateState,
  writeStateAtomic,
  appendCheckpointEvent,
  appendBoundaryEvent,
  type LoopState,
} from "./checkpoint.js";
import { buildBootstrapPacket, writeBootstrapPacket } from "./bootstrap-packet.js";
import { loadConfig } from "../config/loader.js";
import type { ExecutionAdapterMode } from "./execution-adapter.js";
import { runCanonCheck } from "../smartdocs-engine/canon-check.js";
import {
  assertContinueRequiresDispatch,
  advanceContinueEpoch,
} from "./dispatch-boundary.js";
import {
  DEFAULT_LEDGER_PATH,
  LedgerWriter,
  type ClusterCompleteEvent,
  type ChildCompletedEvent,
  type LedgerRunType,
} from "./ledger.js";

export interface ContinueOptions {
  stateFile: string;
  repoRoot: string;
  adapter?: ExecutionAdapterMode;
  /** Override AI provider for the next worker session. */
  provider?: string;
  /** If true, allow analyze-type children to be dispatched (overrides budget.allow_analyze_children). */
  allowAnalyzeChildren?: boolean;
}

function resolveResultFileForChild(state: LoopState, childId: string): string | null {
  const meta = state.open_children_meta?.[childId];
  return meta?.result_file ?? meta?.dispatch_record?.expected_result_path ?? null;
}

type ContinueEvidenceResult =
  | { ok: true; commit: string; rawValidation: unknown; resultFile: string }
  | { ok: false; reason: string };

function verifyCompletionEvidenceForContinue(
  state: LoopState,
  completedChild: string,
  repoRoot: string,
): ContinueEvidenceResult {
  if (state.completed_children.includes(completedChild)) {
    return { ok: true, commit: state.last_commit ?? "", rawValidation: undefined, resultFile: "" };
  }

  const resultFile = resolveResultFileForChild(state, completedChild);
  if (!resultFile) {
    return {
      ok: false,
      reason: `cannot checkpoint ${completedChild}: no result_file evidence found in state metadata`,
    };
  }

  const resolvedResultFile = isAbsolute(resultFile) ? resultFile : resolve(repoRoot, resultFile);
  if (!existsSync(resolvedResultFile)) {
    return {
      ok: false,
      reason: `cannot checkpoint ${completedChild}: expected result file is missing (${resultFile})`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const content = readFileSync(resolvedResultFile, "utf-8");
    const raw = JSON.parse(content) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return {
        ok: false,
        reason: `cannot checkpoint ${completedChild}: result file has invalid JSON shape`,
      };
    }
    parsed = raw as Record<string, unknown>;
  } catch (error) {
    return {
      ok: false,
      reason: `cannot checkpoint ${completedChild}: failed to read result file (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  const status = String(parsed["status"] ?? "").trim().toLowerCase();
  if (!["done", "success"].includes(status)) {
    return {
      ok: false,
      reason: `cannot checkpoint ${completedChild}: result status is "${status || "unknown"}" (expected done/success)`,
    };
  }

  const commit = String(parsed["commit"] ?? parsed["commit_hash"] ?? "").trim();
  if (!commit) {
    if (!readPacketFlag(state, completedChild, repoRoot, "artifact_only")) {
      return {
        ok: false,
        reason: `cannot checkpoint ${completedChild}: result file is missing commit evidence`,
      };
    }
    return { ok: true, commit: "", rawValidation: parsed["validation"], resultFile };
  }

  // Reject placeholder strings that are not valid git hashes (hex, ≥7 chars)
  if (!/^[0-9a-f]{7,}$/i.test(commit)) {
    return {
      ok: false,
      reason: `cannot checkpoint ${completedChild}: result commit "${commit}" is not a valid git hash (expected hex string of ≥7 chars)`,
    };
  }

  return { ok: true, commit, rawValidation: parsed["validation"], resultFile };
}

function resolvePacketPath(state: LoopState, childId: string, repoRoot: string): string | null {
  const dispatchRecord = state.open_children_meta?.[childId]?.dispatch_record;
  const packetPath = dispatchRecord?.packet_path;
  if (!packetPath) return null;
  return isAbsolute(packetPath) ? packetPath : resolve(repoRoot, packetPath);
}

function readPacketFlag(
  state: LoopState,
  childId: string,
  repoRoot: string,
  flag: "artifact_only" | "validation_waiver",
): unknown {
  const packetPath = resolvePacketPath(state, childId, repoRoot);
  if (!packetPath || !existsSync(packetPath)) return undefined;
  try {
    const packet = JSON.parse(readFileSync(packetPath, "utf-8")) as Record<string, unknown>;
    const fromRoot = packet[flag];
    if (fromRoot !== undefined) return fromRoot;
    const instructions = packet["instructions"];
    if (instructions && typeof instructions === "object" && !Array.isArray(instructions)) {
      return (instructions as Record<string, unknown>)[flag];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function hasValidationEvidence(validation: unknown): boolean {
  if (validation === undefined || validation === null) return false;
  if (typeof validation === "boolean") return validation;
  if (typeof validation === "string") {
    const n = validation.trim().toLowerCase();
    return ["passed", "pass", "success", "ok"].includes(n);
  }
  if (typeof validation === "object" && !Array.isArray(validation)) {
    const v = validation as Record<string, unknown>;
    if (Array.isArray(v["passed"]) && (v["passed"] as unknown[]).length > 0) return true;
    if (v["passed"] === true) return true;
    if (typeof v["status"] === "string" && ["passed", "pass", "success", "ok"].includes(v["status"].toLowerCase())) return true;
  }
  return false;
}

function isValidationWaiver(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object" && !Array.isArray(value)) return Object.keys(value).length > 0;
  return false;
}

function toValidationResult(rawValidation: unknown): ValidationResult {
  return {
    passed: hasValidationEvidence(rawValidation),
    output: typeof rawValidation === "string"
      ? rawValidation
      : rawValidation != null ? JSON.stringify(rawValidation) : "",
  };
}

function bridgeEvidenceToClusterState(
  repoRoot: string,
  clusterId: string,
  childId: string,
  commit: string,
  rawValidation: unknown,
  resultFile: string,
): void {
  const existing = readClusterStateSync(clusterId, repoRoot);
  if (!existing) {
    throw new Error(
      `cluster-state.json not found for cluster ${clusterId}; cannot persist evidence for ${childId}`,
    );
  }

  const updatedChildStates: ChildState[] = existing.child_states.some((cs) => cs.id === childId)
    ? existing.child_states.map((cs) =>
        cs.id === childId ? { ...cs, status: "done" as const, commit: commit || undefined } : cs,
      )
    : [...existing.child_states, { id: childId, status: "done" as const, commit: commit || undefined }];

  // Evict any stale commit entry for this child before conditionally re-adding
  const { [childId]: _staleCommit, ...remainingCommits } = existing.commits;

  const updated: ClusterState = {
    ...existing,
    state_generation: existing.state_generation + 1,
    child_states: updatedChildStates,
    commits: commit ? { ...remainingCommits, [childId]: commit } : remainingCommits,
    result_pointers: resultFile ? { ...existing.result_pointers, [childId]: resultFile } : existing.result_pointers,
    validation_results: { ...existing.validation_results, [childId]: toValidationResult(rawValidation) },
  };

  writeClusterStateSync(clusterId, updated, repoRoot);
}

function readSessionTypeFile(repoRoot: string): string | undefined {
  try {
    return readFileSync(join(repoRoot, ".polaris", "session-type"), "utf-8").trim();
  } catch {
    return undefined;
  }
}

function getNextChildType(state: LoopState, nextChild: string | null): string | undefined {
  if (!nextChild) return undefined;
  return state.open_children_meta?.[nextChild]?.type;
}

function isAnalyzeImplBoundary(sessionType: string | undefined, nextChildType: string | undefined): boolean {
  return sessionType === "analyze" && nextChildType === "implement";
}

function normalizeRunType(sessionType: string | undefined): LedgerRunType {
  return sessionType === "analyze" ? "analyze" : "implement";
}

function ledgerBranch(state: LoopState): string {
  return state.branch ?? "unknown";
}

function ledgerLastCommit(state: LoopState): string | null {
  return state.last_commit && state.last_commit.length > 0 ? state.last_commit : null;
}

function appendContinueLedgerEvents(repoRoot: string, state: LoopState, completedChild: string | null): void {
  if (!completedChild) return;

  const writer = new LedgerWriter(join(repoRoot, DEFAULT_LEDGER_PATH));
  const timestamp = new Date().toISOString();
  const base = {
    schema_version: 1 as const,
    event_id: randomUUID(),
    run_id: state.run_id,
    run_type: normalizeRunType(state.session_type),
    cluster_id: state.cluster_id,
    branch: ledgerBranch(state),
    completed_children: Array.from(new Set(state.completed_children)),
    open_children: state.open_children,
    next_child: state.next_open_child,
    last_commit: ledgerLastCommit(state),
    pr_url: null,
    timestamp,
  };

  writer.append({
    ...base,
    event: "child-completed",
    issue_id: completedChild,
    status: state.status === "cluster-complete" ? "cluster-complete" : "running",
    last_commit: ledgerLastCommit(state),
    validation: { status: "complete" },
  } satisfies ChildCompletedEvent);

  if (state.open_children.length === 0) {
    writer.append({
      ...base,
      event_id: randomUUID(),
      event: "cluster-complete",
      issue_id: null,
      status: "cluster-complete",
      open_children: [],
      next_child: null,
    } satisfies ClusterCompleteEvent);
  }
}

export function runLoopContinue(options: ContinueOptions): void {
  const { stateFile, repoRoot, provider, allowAnalyzeChildren } = options;

  // Step 1: Read and validate current-state.json
  let rawState: unknown;
  try {
    rawState = readState(stateFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: cannot read state file ${stateFile}: ${msg}`);
    process.exit(1);
  }

  const validationErrors = validateState(rawState);
  if (validationErrors.length > 0) {
    console.error(
      `current-state.json is invalid — cannot generate bootstrap packet:\n${validationErrors.join("\n")}`,
    );
    process.exit(1);
  }

  const state = rawState as ReturnType<typeof readState>;

  // ── Dispatch boundary enforcement ─────────────────────────────────────────
  // continue MUST be preceded by a `polaris loop dispatch` call.
  // If no dispatch was recorded (dispatch_epoch === continue_epoch),
  // reject immediately and do NOT mutate any state.
  const artifactDirForTelemetry =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFileForCheck = join(artifactDirForTelemetry, "runs", state.run_id, "telemetry.jsonl");

  try {
    assertContinueRequiresDispatch(state, telemetryFileForCheck);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  // Identify the completed child:
  // - If active_child is set, use it (standard case)
  // - If dispatch_epoch > continue_epoch but active_child is empty,
  //   resolve from dispatch_boundary.last_dispatched_child
  let completedChild = state.active_child;
  if (!completedChild && state.dispatch_boundary) {
    const { dispatch_epoch, continue_epoch, last_dispatched_child } = state.dispatch_boundary;
    if (dispatch_epoch > continue_epoch && last_dispatched_child) {
      completedChild = last_dispatched_child;
    }
  }
  const remainingOpenChildren = completedChild
    ? state.open_children.filter((child) => child !== completedChild)
    : state.open_children;
  const nextChild = remainingOpenChildren[0] ?? null;

  let completionCommit = "";
  let completionResultFile = "";
  let completionValidation: unknown = undefined;
  if (state.dispatch_boundary && completedChild) {
    const evidence = verifyCompletionEvidenceForContinue(state, completedChild, repoRoot);
    if (!evidence.ok) {
      console.error(`Error: ${evidence.reason}`);
      process.exit(1);
    }
    completionCommit = evidence.commit;
    completionResultFile = evidence.resultFile;
    completionValidation = evidence.rawValidation;

    // ── Branch custody check ──────────────────────────────────────────────────
    // Reject commits that are already reachable from the base branch.
    // This catches the case where a worker committed directly to main instead
    // of to the delivery branch.
    if (completionCommit) {
      const custodyState = readClusterStateSync(state.cluster_id, repoRoot);
      if (custodyState?.delivery_branch && custodyState?.base_branch) {
        const custodyError = verifyChildCommitCustody(
          repoRoot,
          completionCommit,
          custodyState.delivery_branch,
          custodyState.base_branch,
        );
        if (custodyError) {
          console.error(`Error: branch custody violation for ${completedChild}: ${custodyError}`);
          process.exit(1);
        }
      }
    }

    if (!hasValidationEvidence(completionValidation)) {
      const waiver = readPacketFlag(state, completedChild, repoRoot, "validation_waiver");
      if (!isValidationWaiver(waiver)) {
        console.error(
          `Error: cannot checkpoint ${completedChild}: result file has no passing validation evidence and no validation_waiver was set in the packet`,
        );
        process.exit(1);
      }
    }
  }

  // Determine session type (state field takes precedence, file is secondary signal)
  const sessionTypeFile = readSessionTypeFile(repoRoot);
  const sessionType = state.session_type ?? sessionTypeFile;
  if (sessionTypeFile && !state.session_type) {
    console.warn(`Warning: session_type not in state; using .polaris/session-type file: ${sessionTypeFile}`);
  }

  // Update state: mark active_child as completed
  const newCompletedChildren = completedChild
    ? Array.from(new Set([...state.completed_children, completedChild]))
    : state.completed_children;
  const completedSet = new Set(newCompletedChildren);
  const prunedOpenChildrenMeta = state.open_children_meta
    ? Object.fromEntries(
        Object.entries(state.open_children_meta).filter(([id]) => !completedSet.has(id)),
      )
    : undefined;

  // Record per-child result summary in loop state (belt-and-suspenders for finalize evidence)
  const updatedCompletedChildrenResults: Record<string, import("./checkpoint.js").ChildResultSummary> = {
    ...(state.completed_children_results ?? {}),
  };
  if (completedChild && completionResultFile) {
    updatedCompletedChildrenResults[completedChild] = {
      status: "done",
      validation: hasValidationEvidence(completionValidation) ? "passed" : "skipped",
      commit: completionCommit || null,
      next_recommended_action: "continue",
    };
  }

  const updatedState = {
    ...state,
    active_child: "",
    completed_children: newCompletedChildren,
    completed_children_results:
      Object.keys(updatedCompletedChildrenResults).length > 0
        ? updatedCompletedChildrenResults
        : state.completed_children_results,
    open_children: remainingOpenChildren,
    open_children_meta: prunedOpenChildrenMeta,
    step_cursor: "checkpoint",
    next_open_child: nextChild,
    status: nextChild ? "running" : "cluster-complete",
    context_budget: {
      ...state.context_budget,
      children_completed: newCompletedChildren.length,
    },
    last_commit: completionCommit || state.last_commit,
    // Advance continue_epoch to match the consumed dispatch_epoch
    dispatch_boundary: advanceContinueEpoch(state.dispatch_boundary),
  };

  // Bridge evidence to cluster-state BEFORE committing the pruned loop state.
  // Failing here leaves open_children_meta intact so the operator can retry.
  if (state.dispatch_boundary && completedChild && completionResultFile) {
    try {
      bridgeEvidenceToClusterState(
        repoRoot,
        state.cluster_id,
        completedChild,
        completionCommit,
        completionValidation,
        completionResultFile,
      );
    } catch (error) {
      console.error(
        `Error: failed to persist cluster-state evidence for ${completedChild}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exit(1);
    }
  }

  // Step 1 (cont): Atomic write of updated current-state.json (open_children_meta pruned after bridge)
  const sha = writeStateAtomic(stateFile, updatedState);
  appendContinueLedgerEvents(repoRoot, updatedState, completedChild);

  // Step 2: Append JSONL checkpoint event
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
  appendCheckpointEvent(telemetryFile, {
    event: "loop-checkpoint",
    run_id: state.run_id,
    child_id: completedChild,
    next_child: nextChild,
    timestamp: new Date().toISOString(),
  });

  // Load config early — needed for canon check and adapter selection
  const config = loadConfig(repoRoot);
  const effectiveConfig = {
    ...config,
    execution: provider
      ? {
          ...config.execution,
          rotation: [
            provider,
            ...(config.execution.rotation ?? []).filter((name) => name !== provider),
          ],
        }
      : config.execution,
    budget:
      allowAnalyzeChildren === undefined
        ? config.budget
        : {
            ...config.budget,
            allow_analyze_children: allowAnalyzeChildren,
          },
  };
  const effectiveExecution = {
    ...effectiveConfig.execution,
    allow_analyze_children: effectiveConfig.budget?.allow_analyze_children,
  };

  // Map update runs once at session end (step 08 / polaris finalize), not per checkpoint.

  // Step 3.5: Canon reconciliation check
  const canonCheckEnabled = effectiveConfig.canon?.checkOnContinue !== false;
  if (canonCheckEnabled && nextChild) {
    const changedFiles: string[] = (updatedState as Record<string, unknown>)["changed_files"] as string[] ?? [];
    const canonResult = runCanonCheck({
      repoRoot,
      changedFiles,
      childId: nextChild,
      runId: state.run_id,
      telemetryFile,
    });
    if (canonResult.outcome === "stale-implementation") {
      const conflict = canonResult.conflicts.find((c) => c.type === "stale-implementation");
      process.stderr.write(
        [
          `Canon conflict halt — cannot generate bootstrap packet.`,
          `Canon file: ${conflict?.canonFile ?? "unknown"}`,
          `Statement: ${conflict?.statement ?? ""}`,
          `Affected file: ${conflict?.changedFile ?? ""}`,
          `Detail: ${conflict?.detail ?? ""}`,
          `Resolution: Update the canon file or implement the missing piece before continuing.`,
        ].join("\n") + "\n",
      );
      process.exit(1);
    }
  }

  // Step 4: Analyze→implementation boundary check
  const nextChildType = getNextChildType(state, nextChild);
  const boundaryTriggered = isAnalyzeImplBoundary(sessionType, nextChildType);

  if (boundaryTriggered) {
    appendBoundaryEvent(telemetryFile, {
      event: "analyze-impl-boundary-enforced",
      run_id: state.run_id,
      stopped_before: nextChild,
      reason: "analyze session cannot auto-continue into implementation",
      timestamp: new Date().toISOString(),
    });
  }

  // Steps 4-5: Generate and write bootstrap packet
  const packet = buildBootstrapPacket(
    updatedState,
    stateFile,
    sha,
    repoRoot,
    completedChild,
    (options.adapter ?? effectiveExecution.adapter) as ExecutionAdapterMode | undefined,
    effectiveExecution,
  );
  if (boundaryTriggered) {
    packet.boundary_enforcement =
      "analyze-session-ended; implementation requires fresh session with explicit impl scope";
  }
  const bootstrapDir = join(repoRoot, ".polaris", "bootstrap");
  const packetPath = writeBootstrapPacket(packet, bootstrapDir);

  // Step 6: Emit bootstrap packet to stdout, exit 0
  console.log(JSON.stringify(packet, null, 2));
  process.stderr.write(`Bootstrap packet written to: ${packetPath}\n`);
}
