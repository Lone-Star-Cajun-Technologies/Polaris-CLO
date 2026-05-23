import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

export interface ContinueOptions {
  stateFile: string;
  repoRoot: string;
  adapter?: ExecutionAdapterMode;
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
  const { stateFile, repoRoot } = options;

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
  const completedChild = state.active_child;
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
  const updatedState = {
    ...state,
    active_child: "",
    completed_children: completedChild
      ? [...state.completed_children, completedChild]
      : state.completed_children,
    open_children: remainingOpenChildren,
    step_cursor: "checkpoint",
    next_open_child: nextChild,
    status: nextChild ? "running" : "cluster-complete",
    context_budget: {
      ...state.context_budget,
      children_completed: state.context_budget.children_completed + (completedChild ? 1 : 0),
    },
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

  // Step 3: Run polaris map update --changed (non-fatal if not yet implemented)
  const mapResult = spawnSync(
    process.execPath,
    [resolve(repoRoot, "dist/cli/index.js"), "map", "update", "--changed"],
    { cwd: repoRoot, encoding: "utf-8" },
  );
  if (mapResult.status !== 0) {
    console.warn(
      "Warning: polaris map update --changed failed (map not yet implemented). Continuing.",
    );
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
  const config = loadConfig(repoRoot);
  const packet = buildBootstrapPacket(
    updatedState,
    stateFile,
    sha,
    repoRoot,
    completedChild,
    options.adapter ?? config.execution.adapter,
    config.execution,
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
