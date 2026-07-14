import { execFileSync } from "node:child_process";
import type { LoopState } from "../../loop/checkpoint.js";
import type { QcRepairLoopState } from "../../loop/checkpoint.js";
import { createDraftPr } from "../github.js";

function getHeadSha(repoRoot: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();
}

type QcRepairLoopStateWithSeal = QcRepairLoopState & { sealed_head_sha?: string };

export function stepCreatePr(
  repoRoot: string,
  branch: string,
  state: LoopState,
  draft: boolean,
  authoritativeChildCount?: number,
): string {
  const loop = state.qc_repair_loop as QcRepairLoopStateWithSeal | undefined;
  const sealedHeadSha = loop?.sealed_head_sha;
  if (sealedHeadSha) {
    const currentHeadSha = getHeadSha(repoRoot);
    if (currentHeadSha !== sealedHeadSha) {
      throw new Error(
        `PR intended head SHA (${currentHeadSha}) does not match the sealed QC head SHA (${sealedHeadSha}). ` +
          `The branch has changed since the QC seal was recorded. ` +
          `Rerun the completed-cluster QC or escalate the mismatch before creating a PR.`,
      );
    }
  }

  const prUrl = createDraftPr({ repoRoot, branch, state, draft, authoritativeChildCount });
  console.log(`PR created: ${prUrl}`);
  return prUrl;
}
