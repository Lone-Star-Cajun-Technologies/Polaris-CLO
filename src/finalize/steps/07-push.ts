import { execFileSync } from "node:child_process";

export function stepPush(repoRoot: string, branch: string): void {
  execFileSync("git", ["push", "-u", "origin", branch], {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
