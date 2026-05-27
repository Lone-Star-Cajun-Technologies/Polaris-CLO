import { Command } from "commander";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readState } from "../loop/checkpoint.js";
import { runCanonCheck } from "../smartdocs/canon-check.js";
import { stepMapUpdate } from "./steps/01-map-update.js";
import { stepMapValidate } from "./steps/02-map-validate.js";
import { stepSchemaValidate } from "./steps/03-schema-validate.js";
import { stepRunChecks } from "./steps/04-run-checks.js";
import { stepGenerateReport } from "./steps/05-generate-report.js";
import { stepCommit } from "./steps/06-commit.js";
import { stepPush } from "./steps/07-push.js";
import { stepCreatePr } from "./steps/08-create-pr.js";
import { stepUpdateState } from "./steps/09-update-state.js";
import { stepAppendJsonl } from "./steps/10-append-jsonl.js";
import { stepUpdateLinear } from "./steps/11-update-linear.js";
import { stepArchive } from "./steps/12-archive.js";

export interface FinalizeOptions {
  repoRoot: string;
  stateFile: string;
  dryRun?: boolean;
  skipDelivery?: boolean;
}

function getBranch(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to get current branch in ${repoRoot}: ${msg}`);
  }
}

export async function runFinalize(options: FinalizeOptions): Promise<void> {
  const { repoRoot, stateFile, dryRun, skipDelivery } = options;
  const config = loadConfig(repoRoot);

  // Step 1: polaris map update --changed
  console.log("[1/12] Updating map...");
  stepMapUpdate(repoRoot);

  // Step 2: polaris map validate — fail fast
  console.log("[2/12] Validating map...");
  stepMapValidate(repoRoot);

  // Step 3: Validate current-state.json schema
  console.log("[3/12] Validating current-state.json schema...");
  let rawState: unknown;
  try {
    rawState = readState(stateFile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`finalize aborted: cannot read state file ${stateFile}: ${msg}\n`);
    process.exit(1);
  }
  stepSchemaValidate(rawState);

  let state = rawState as ReturnType<typeof readState>;

  // Step 4: Run configured checks
  const checks = config.finalize?.runChecks ?? [];
  if (checks.length > 0) {
    console.log(`[4/12] Running ${checks.length} configured check(s)...`);
    stepRunChecks(repoRoot, checks);
  } else {
    console.log("[4/12] No finalize.runChecks configured — skipping.");
  }

  // Step 4.5: Canon reconciliation check
  const canonCheckEnabled = config.canon?.checkOnFinalize !== false;
  if (canonCheckEnabled) {
    console.log("[4.5/12] Running canon reconciliation check...");
    let changedFiles: string[] = [];
    try {
      const baseBranch = config.finalize?.targetBranch ?? "main";
      const diffOutput = execFileSync(
        "git",
        ["diff", "--name-only", `${baseBranch}...HEAD`],
        { cwd: repoRoot, encoding: "utf-8" },
      );
      changedFiles = diffOutput.trim().split("\n").filter(Boolean);
    } catch (err) {
      // Fail closed: if git diff fails, we cannot determine changed files for canon check
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: git diff failed during canon check: ${msg}`);
      throw new Error(`Canon check cannot proceed: git diff failed: ${msg}`);
    }

    const artifactDirForCheck = state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
    const telemetryFileForCheck = join(artifactDirForCheck, "runs", state.run_id, "telemetry.jsonl");

    const canonResult = runCanonCheck({
      repoRoot,
      changedFiles,
      childId: undefined,
      runId: state.run_id,
      telemetryFile: telemetryFileForCheck,
    });

    if (canonResult.outcome === "stale-implementation") {
      const conflict = canonResult.conflicts.find((c) => c.type === "stale-implementation");
      process.stderr.write(
        [
          `Canon conflict halt — finalize blocked. PR will not be created.`,
          `Canon file: ${conflict?.canonFile ?? "unknown"}`,
          `Statement: ${conflict?.statement ?? ""}`,
          `Affected file: ${conflict?.changedFile ?? ""}`,
          `Detail: ${conflict?.detail ?? ""}`,
          `Resolution: Update the canon file or implement the missing piece before finalizing.`,
        ].join("\n") + "\n",
      );
      process.exit(1);
    }
  }

  // Step 5: Generate run-report.md (written once, never updated)
  console.log("[5/12] Generating run-report.md...");
  const branch = getBranch(repoRoot);
  const reportPath = stepGenerateReport(repoRoot, state, branch, true);

  if (dryRun) {
    console.log("[6–12/12] Dry run — skipping commit and delivery.");
    console.log("Finalize dry run complete.");
    return;
  }

  // Step 6: Single final commit: state + map + run-report
  console.log("[6/12] Committing state + map + run-report...");
  const resolvedStateFile = resolve(stateFile);
  stepCommit(repoRoot, state, resolvedStateFile, reportPath);

  if (skipDelivery) {
    console.log("[7–12/12] Delivery skipped (--skip-delivery).");
    console.log("polaris finalize steps 1–6 complete.");
    return;
  }

  // Step 7: git push
  console.log("[7/12] Pushing branch...");
  stepPush(repoRoot, branch);

  // Step 8: Create draft PR
  const prDraft = config.finalize?.prDraft ?? true;
  console.log("[8/12] Creating draft PR...");
  const prUrl = stepCreatePr(repoRoot, branch, state, prDraft);

  // Step 9: Write PR URL to current-state.json
  console.log("[9/12] Writing PR URL to state...");
  state = stepUpdateState(resolvedStateFile, state, prUrl);

  // Step 10: Append JSONL events
  console.log("[10/12] Appending JSONL events...");
  const artifactDir = state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "bootstrap-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
  stepAppendJsonl(telemetryFile, state, prUrl);

  // Step 11: Update Linear parent issue
  console.log("[11/12] Updating Linear...");
  const linearEnabled = config.tracker?.linear?.enabled ?? false;
  await stepUpdateLinear(state, branch, prUrl, true, linearEnabled, state.cluster_id);

  // Step 12: Archive run snapshot
  console.log("[12/12] Archiving run snapshot...");
  stepArchive(repoRoot, state, resolvedStateFile, reportPath);

  console.log("polaris finalize complete.");
}

export interface FinalizeCommandHandlers {
  runFinalize?: typeof runFinalize;
  repoRoot?: string;
}

function failMissingSubcommand(command: Command, commandName: string): never {
  const unknownSubcommand = command.args[0];
  const message = unknownSubcommand
    ? `error: unknown command '${unknownSubcommand}' for '${commandName}'. Run '${commandName} --help'.`
    : `error: missing command for '${commandName}'. Run '${commandName} --help'.`;
  command.error(message, {
    code: "commander.missingCommand",
    exitCode: 1,
  });
}

export function createFinalizeCommand(handlers: FinalizeCommandHandlers = {}): Command {
  const finalizeHandler = handlers.runFinalize ?? runFinalize;
  const repoRootDefault = handlers.repoRoot ?? process.cwd();
  const finalize = new Command("finalize")
    .description(
      "manual/operator-triggered delivery; finalize run performs delivery unless --dry-run or --skip-delivery is supplied",
    )
    .showHelpAfterError()
    .showSuggestionAfterError();
  finalize.action(() => failMissingSubcommand(finalize, "polaris finalize"));

  finalize
    .command("run")
    .description("mutating: run manual/operator-triggered finalize and perform delivery")
    .option("-r, --repo-root <path>", "Repository root", repoRootDefault)
    .option("--state-file <path>", "Path to current-state.json")
    .option("--dry-run", "non-mutating preview: validate and generate report without committing or pushing")
    .option("--skip-delivery", "perform local finalize steps only; skip push/PR/Linear/archive")
    .action((options: { repoRoot: string; stateFile?: string; dryRun?: boolean; skipDelivery?: boolean }) => {
      const repoRoot = options.repoRoot;
      const stateFile =
        options.stateFile ?? join(repoRoot, ".polaris", "runs", "current-state.json");
      finalizeHandler({ repoRoot, stateFile, dryRun: options.dryRun, skipDelivery: options.skipDelivery })
        .catch((err: unknown) => {
          process.stderr.write(`finalize error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        });
    });

  return finalize;
}
