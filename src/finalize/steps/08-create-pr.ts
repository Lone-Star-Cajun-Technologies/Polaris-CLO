import type { LoopState } from "../../loop/checkpoint.js";
import { createDraftPr } from "../github.js";

export function stepCreatePr(
  repoRoot: string,
  branch: string,
  state: LoopState,
  draft: boolean,
): string {
  const prUrl = createDraftPr({ repoRoot, branch, state, draft });
  console.log(`PR created: ${prUrl}`);
  return prUrl;
}
