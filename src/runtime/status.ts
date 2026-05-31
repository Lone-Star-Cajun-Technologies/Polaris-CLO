import { loadState, listArtifactDirs } from "./state.js";
import type { CurrentState } from "../types/runtime-state.js";

export interface RunSummary {
  artifact_dir: string;
  run_id?: string;
  status: string;
  step_cursor?: string;
  cluster_id?: string;
  open_children_count?: number;
  completed_children_count?: number;
}

export async function getOverallStatus(): Promise<{ runs: RunSummary[] }> {
  const dirs = await listArtifactDirs();
  const runs = await Promise.all(
    dirs.map(async (dir) => {
      const state = await loadState(dir);
      return state
        ? {
            artifact_dir: dir,
            run_id: state.run_id,
            status: state.status,
            step_cursor: state.step_cursor,
            cluster_id: state.cluster_id,
            open_children_count: state.open_children.length,
            completed_children_count: state.completed_children.length,
          }
        : { artifact_dir: dir, status: "unreadable" };
    })
  );
  return { runs };
}

export async function getLoopStatus(artifactDir: string): Promise<(Omit<CurrentState, "schema_version"> & { artifact_dir: string }) | null> {
  const state = await loadState(artifactDir);
  if (!state) return null;
  return {
    artifact_dir: artifactDir,
    run_id: state.run_id,
    cluster_id: state.cluster_id,
    status: state.status,
    step_cursor: state.step_cursor,
    active_child: state.active_child,
    open_children: state.open_children,
    completed_children: state.completed_children,
    context_budget: state.context_budget,
    runtime_generation: state.runtime_generation,
    orchestration_mode: state.orchestration_mode,
    continuation_epoch: state.continuation_epoch,
  };
}

export async function getCurrentState(artifactDir: string): Promise<CurrentState | null> {
  return loadState(artifactDir);
}
