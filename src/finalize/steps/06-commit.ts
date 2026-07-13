import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LoopState } from "../../loop/checkpoint.js";
import {
  findArtifactPromotionViolations,
  getArtifactPromotionStageTargets,
} from "../artifact-policy.js";

export function stepCommit(repoRoot: string, state: LoopState, _stateFile: string, _reportPath: string): string {
  const msg = `polaris finalize: ${state.run_id}\n\nChildren: ${state.completed_children.length} completed\nBranch: ${getBranch(repoRoot)}`;
  const promotedTargets = getArtifactPromotionStageTargets(state.cluster_id)
    .filter((target) => existsSync(join(repoRoot, target)));
  if (promotedTargets.length > 0) {
    execFileSync("git", ["add", "--", ...promotedTargets], { cwd: repoRoot, stdio: "inherit" });
  }
  const stagedPaths = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim().split("\n").filter(Boolean);
  const blockedArtifacts = findArtifactPromotionViolations(stagedPaths, state.cluster_id)
    .map((violation) => violation.path);
  if (blockedArtifacts.length > 0) {
    execFileSync("git", ["restore", "--staged", "--", ...blockedArtifacts], { cwd: repoRoot, stdio: "inherit" });
  }
  execFileSync("git", ["commit", "--allow-empty", "-m", msg], { cwd: repoRoot, stdio: "inherit" });

  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" }).trim();
  console.log(`Finalize commit: ${sha}`);
  return sha;
}

function getBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}
