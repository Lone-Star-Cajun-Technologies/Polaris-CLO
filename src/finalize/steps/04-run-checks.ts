import { spawnSync } from "node:child_process";

export function stepRunChecks(repoRoot: string, checks: string[]): void {
  for (const check of checks) {
    const [cmd, ...args] = check.split(" ");
    if (!cmd) continue;
    const result = spawnSync(cmd, args, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) {
      process.stderr.write(`finalize aborted: check failed: ${check}\n`);
      process.exit(1);
    }
  }
}
