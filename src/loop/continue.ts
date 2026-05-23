import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readState,
  validateState,
  writeStateAtomic,
  appendCheckpointEvent,
} from "./checkpoint.js";
import { buildBootstrapPacket, writeBootstrapPacket } from "./bootstrap-packet.js";

export interface ContinueOptions {
  stateFile: string;
  repoRoot: string;
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
  const nextChild = state.open_children[0] ?? null;

  // Update state: mark active_child as completed
  const updatedState = {
    ...state,
    active_child: "",
    completed_children: completedChild
      ? [...state.completed_children, completedChild]
      : state.completed_children,
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

  // Steps 4-5: Generate and write bootstrap packet
  const packet = buildBootstrapPacket(updatedState, stateFile, sha, repoRoot, completedChild);
  const bootstrapDir = join(repoRoot, ".polaris", "bootstrap");
  const packetPath = writeBootstrapPacket(packet, bootstrapDir);

  // Step 6: Emit bootstrap packet to stdout, exit 0
  console.log(JSON.stringify(packet, null, 2));
  process.stderr.write(`Bootstrap packet written to: ${packetPath}\n`);
}
