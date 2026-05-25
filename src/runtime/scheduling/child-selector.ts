import type { CurrentState } from "../../types/runtime-state.js";

/**
 * Select the next child to execute.
 *
 * TODO: TEMPORARY — lexical sort of issue IDs is a placeholder only.
 * Real scheduling must come from runtime orchestration policy (priority,
 * dependencies, cycle assignment, etc.). Do not treat this ordering as
 * authoritative. Replace with a SchedulingService in a future cluster.
 */
export function selectNextChild(state: CurrentState): string | null {
  if (state.open_children.length === 0) return null;
  return [...state.open_children].sort()[0] ?? null;
}
