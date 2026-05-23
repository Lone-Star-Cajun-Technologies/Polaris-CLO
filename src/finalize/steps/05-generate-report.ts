import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { LoopState } from "../../loop/checkpoint.js";
import { generateRunReport } from "../run-report.js";

export function stepGenerateReport(
  repoRoot: string,
  state: LoopState,
  branch: string,
  validationPassed: boolean,
): string {
  const reportPath = resolve(repoRoot, ".polaris", "runs", "run-report.md");
  mkdirSync(dirname(reportPath), { recursive: true });
  const content = generateRunReport({ state, branch, validationPassed });
  writeFileSync(reportPath, content, "utf-8");
  console.log(`Run report written: ${reportPath}`);
  return reportPath;
}
