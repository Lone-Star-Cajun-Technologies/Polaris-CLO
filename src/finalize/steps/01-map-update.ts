import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

function ownDistCliPath(): string {
  // resolve from THIS source file: dist/cli/index.js lives next to this compiled output
  return join(dirname(dirname(__dirname)), "dist", "cli", "index.js");
}

export function stepMapUpdate(repoRoot: string): void {
  const cliPath = ownDistCliPath();
  const result = spawnSync(
    process.execPath,
    [cliPath, "map", "update", "--changed"],
    { cwd: repoRoot, encoding: "utf-8", stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.stderr.write("Warning: map update --changed failed; proceeding to validate.\n");
  }
}
