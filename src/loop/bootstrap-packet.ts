import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import type { LoopState } from "./checkpoint.js";

export interface BootstrapPacket {
  run_id: string;
  skill: string;
  branch: string;
  last_completed_step: string;
  last_completed_child: string;
  next_step: string;
  open_children: string[];
  artifact_pointers: {
    current_state: string;
    telemetry: string;
  };
  context_budget: {
    children_completed: number;
    files_touched_total: number;
    stop_threshold_remaining: number;
  };
  current_state_sha: string;
  resume_instructions: string;
}

function getCurrentBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

export function buildBootstrapPacket(
  state: LoopState,
  stateFile: string,
  currentStateSha: string,
  repoRoot: string,
  completedChild: string,
): BootstrapPacket {
  const branch = getCurrentBranch(repoRoot);
  const nextChild = state.open_children[0] ?? null;
  const maxChildren = state.context_budget.max_children_per_session ?? 3;
  const filesTouched = state.context_budget.files_touched_total ?? 0;
  const stopThresholdRemaining = maxChildren - state.context_budget.children_completed;
  const artifactDir =
    state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");

  const resumeInstructions = nextChild
    ? `Run \`polaris loop resume ${state.run_id}\` on branch \`${branch}\` to continue with ${nextChild}.`
    : `All children complete. Run \`polaris loop status\` to verify cluster state.`;

  return {
    run_id: state.run_id,
    skill: state.skill ?? "bootstrap-run",
    branch,
    last_completed_step: state.step_cursor,
    last_completed_child: completedChild,
    next_step: nextChild ? "03-execute-child" : "CLUSTER-COMPLETE",
    open_children: state.open_children,
    artifact_pointers: {
      current_state: stateFile,
      telemetry: telemetryFile,
    },
    context_budget: {
      children_completed: state.context_budget.children_completed,
      files_touched_total: filesTouched,
      stop_threshold_remaining: stopThresholdRemaining,
    },
    current_state_sha: currentStateSha,
    resume_instructions: resumeInstructions,
  };
}

export function writeBootstrapPacket(
  packet: BootstrapPacket,
  bootstrapDir: string,
): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${packet.run_id}-${timestamp}.json`;
  const outPath = join(bootstrapDir, filename);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(packet, null, 2), "utf-8");
  return outPath;
}
