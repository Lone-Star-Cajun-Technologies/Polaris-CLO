import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LoopState } from "../../loop/checkpoint.js";

export function stepArchive(
  repoRoot: string,
  state: LoopState,
  stateFile: string,
  reportPath: string,
): void {
  const archiveDir = resolve(repoRoot, ".polaris", "runs", state.run_id);
  mkdirSync(archiveDir, { recursive: true });

  copyFileSync(stateFile, join(archiveDir, "current-state.json"));

  if (existsSync(reportPath)) {
    copyFileSync(reportPath, join(archiveDir, "run-report.md"));
  }

  const mapDir = resolve(repoRoot, ".polaris", "map");
  for (const file of ["file-routes.json", "needs-review.json", "exemptions.json", "atlas-index.json"]) {
    const src = join(mapDir, file);
    if (existsSync(src)) {
      copyFileSync(src, join(archiveDir, file));
    }
  }

  console.log(`Run archived to .polaris/runs/${state.run_id}/`);
}
