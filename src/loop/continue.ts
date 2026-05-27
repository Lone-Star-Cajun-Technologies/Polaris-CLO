import { join } from "node:path";
import { readFileSync } from "node:fs";
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

export interface ContinueOptions {
  stateFile: string;
  repoRoot: string;
  adapter?: ExecutionAdapterMode;
  /** Override AI provider for the next worker session. */
  provider?: string;
  /** If true, allow analyze-type children to be dispatched (overrides budget.allow_analyze_children). */
  allowAnalyzeChildren?: boolean;
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
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
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

  // Determine session type (state field takes precedence, file is secondary signal)
  const sessionTypeFile = readSessionTypeFile(repoRoot);
  const sessionType = state.session_type ?? sessionTypeFile;
  if (sessionTypeFile && !state.session_type) {
    console.warn(`Warning: session_type not in state; using .polaris/session-type file: ${sessionTypeFile}`);
  }

  // Update state: mark active_child as completed
  const newCompletedChildren = completedChild
    ? [...state.completed_children, completedChild]
    : state.completed_children;
  const updatedState = {
    ...state,
    active_child: "",
    completed_children: newCompletedChildren,
    open_children: remainingOpenChildren,
    step_cursor: "checkpoint",
    next_open_child: nextChild,
    status: nextChild ? "running" : "cluster-complete",
    context_budget: {
      ...state.context_budget,
      children_completed: newCompletedChildren.length,
    },
    // Advance continue_epoch to match the consumed dispatch_epoch
    dispatch_boundary: advanceContinueEpoch(state.dispatch_boundary),
  };

  // Step 1 (cont): Atomic write of updated current-state.json
  const sha = writeStateAtomic(stateFile, updatedState);

  // Step 2: Append JSONL checkpoint event
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
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
