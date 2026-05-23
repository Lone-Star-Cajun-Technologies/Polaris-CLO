import { execFileSync } from "node:child_process";
import type { LoopState } from "../../loop/checkpoint.js";

export function stepCommit(repoRoot: string, state: LoopState, stateFile: string, reportPath: string): string {
  const msg = `polaris finalize: ${state.run_id}\n\nChildren: ${state.completed_children.length} completed\nBranch: ${getBranch(repoRoot)}`;

  execFileSync("git", ["add", stateFile, reportPath], { cwd: repoRoot, stdio: "inherit" });
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
