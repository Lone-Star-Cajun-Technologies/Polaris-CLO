import type { LoopState } from "../../loop/checkpoint.js";
import { writeStateAtomic } from "../../loop/checkpoint.js";

export function stepUpdateState(stateFile: string, state: LoopState, prUrl: string): LoopState {
  const updated = { ...state, pr_url: prUrl, status: "complete" } as LoopState & { pr_url: string };
  writeStateAtomic(stateFile, updated);
  return updated;
}
