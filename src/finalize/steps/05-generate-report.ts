import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { LoopState } from "../../loop/checkpoint.js";
import { readJsonLines } from "../../autoresearch/gates.js";
import { generateRunReport } from "../run-report.js";

export function stepGenerateReport(
  repoRoot: string,
  state: LoopState,
  branch: string,
  validationPassed: boolean,
): string {
  const reportPath = resolve(repoRoot, ".polaris", "runs", "run-report.md");
  mkdirSync(dirname(reportPath), { recursive: true });

  const telemetryFile = state.artifact_dir
    ? join(state.artifact_dir, "runs", state.run_id, "telemetry.jsonl")
    : join(repoRoot, ".taskchain_artifacts", "polaris-run", "runs", state.run_id, "telemetry.jsonl");
  const telemetryEvents = readJsonLines(telemetryFile);

  const content = generateRunReport({ state, branch, validationPassed, telemetryEvents });
  writeFileSync(reportPath, content, "utf-8");
  console.log(`Run report written: ${reportPath}`);
  return reportPath;
}
