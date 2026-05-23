import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function stepMapUpdate(repoRoot: string): void {
  const result = spawnSync(
    process.execPath,
    [resolve(repoRoot, "dist/cli/index.js"), "map", "update", "--changed"],
    { cwd: repoRoot, encoding: "utf-8", stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.stderr.write("Warning: map update --changed failed; proceeding to validate.\n");
  }
}
