import { Command } from "commander";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readState, validateState } from "../loop/checkpoint.js";
import { stepMapUpdate } from "./steps/01-map-update.js";
import { stepMapValidate } from "./steps/02-map-validate.js";
import { stepSchemaValidate } from "./steps/03-schema-validate.js";
import { stepRunChecks } from "./steps/04-run-checks.js";
import { stepGenerateReport } from "./steps/05-generate-report.js";
import { stepCommit } from "./steps/06-commit.js";

export interface FinalizeOptions {
  repoRoot: string;
  stateFile: string;
  dryRun?: boolean;
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

export function runFinalize(options: FinalizeOptions): void {
  const { repoRoot, stateFile, dryRun } = options;
  const config = loadConfig(repoRoot);

  // Step 1: polaris map update --changed
  console.log("[1/6] Updating map...");
  stepMapUpdate(repoRoot);

  // Step 2: polaris map validate — fail fast
  console.log("[2/6] Validating map...");
  stepMapValidate(repoRoot);

  // Step 3: Validate current-state.json schema
  console.log("[3/6] Validating current-state.json schema...");
  let rawState: unknown;
  try {
    rawState = readState(stateFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`finalize aborted: cannot read state file ${stateFile}: ${msg}\n`);
    process.exit(1);
  }
  stepSchemaValidate(rawState);

  const state = rawState as ReturnType<typeof readState>;

  // Step 4: Run configured checks
  const checks = config.finalize?.runChecks ?? [];
  if (checks.length > 0) {
    console.log(`[4/6] Running ${checks.length} configured check(s)...`);
    stepRunChecks(repoRoot, checks);
  } else {
    console.log("[4/6] No finalize.runChecks configured — skipping.");
  }

  // Step 5: Generate run-report.md (written once, never updated)
  console.log("[5/6] Generating run-report.md...");
  const branch = getBranch(repoRoot);
  const reportPath = stepGenerateReport(repoRoot, state, branch, true);

  if (dryRun) {
    console.log("[6/6] Dry run — skipping commit.");
    console.log("Finalize steps 1–6 complete (dry run).");
    return;
  }

  // Step 6: Single final commit: state + map + run-report
  console.log("[6/6] Committing state + map + run-report...");
  const resolvedStateFile = resolve(stateFile);
  stepCommit(repoRoot, state, resolvedStateFile, reportPath);

  console.log("polaris finalize steps 1–6 complete.");
}

export function createFinalizeCommand(): Command {
  const finalize = new Command("finalize").description(
    "Atomic 12-step final delivery sequence (steps 1–6: validate, checks, report, commit)",
  );

  finalize
    .command("run")
    .description("Run polaris finalize steps 1–6")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option(
      "--state-file <path>",
      "Path to current-state.json",
    )
    .option("--dry-run", "Validate and generate report without committing")
    .action((options: { repoRoot: string; stateFile?: string; dryRun?: boolean }) => {
      const repoRoot = options.repoRoot;
      const stateFile =
        options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");
      runFinalize({ repoRoot, stateFile, dryRun: options.dryRun });
    });

  return finalize;
}
