import { Command } from "commander";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { readState } from "../loop/checkpoint.js";
import { classifyArtifactPath } from "./artifact-policy.js";
import { hasNonArtifactSourceChanges, verifyChildCommitCustody } from "../loop/git-custody.js";
import { readClusterStateSync } from "../cluster-state/store.js";
import { runCanonCheck } from "../smartdocs-engine/canon-check.js";
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
import { LocalGraph } from "../tracker/local-graph.js";
import { TrackerSyncService } from "../tracker/sync/index.js";
import { formatFinalizeEvidenceFailures, verifyCompletedChildFinalizeEvidence } from "../loop/finalize-evidence.js";
import { validateDeliveryIntegrity } from "./delivery-integrity.js";

export interface FinalizeOptions {
  repoRoot: string;
  stateFile: string;
  dryRun?: boolean;
  skipDelivery?: boolean;
}

/**
 * Retrieve the current git branch name for the repository at `repoRoot`.
 *
 * @param repoRoot - Filesystem path to the repository root
 * @returns The branch name as returned by `git rev-parse --abbrev-ref HEAD`, trimmed of surrounding whitespace
 * @throws Error if the git command fails or the branch cannot be determined
 */
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

/**
 * Normalize a Git branch name into a lowercase, dash-separated form.
 *
 * @returns The input branch converted to lowercase with all underscores (`_`) replaced by hyphens (`-`)
 */
function normalizeBranchName(branch: string): string {
  return branch.toLowerCase().replace(/_/g, "-");
}

/**
 * Extracts a normalized cluster slug from a cluster identifier.
 *
 * @param clusterId - The cluster identifier to parse for a slug.
 * @returns The slug normalized to lowercase with underscores replaced by hyphens; if the identifier contains a substring matching the pattern `ABC-123` (uppercase letters, a hyphen, then digits) that substring is used, otherwise the entire identifier is normalized.
 */
function extractClusterSlug(clusterId: string): string {
  const match = clusterId.match(/([A-Z]+-\d+)/);
  return match ? normalizeBranchName(match[1]) : normalizeBranchName(clusterId);
}

/**
 * Ensures the provided state file path is not a known debug or legacy location.
 *
 * If the path ends with ".taskchain_artifacts/polaris-run/current-state.json" or
 * ".polaris/runs/current-state.json", an error is written to stderr and the process
 * exits with code 1.
 *
 * @param stateFile - Filesystem path to validate
 */
function validateStateFilePath(stateFile: string): void {
  const normalizedPath = stateFile.replace(/\\/g, "/");
  const debugPath = ".taskchain_artifacts/polaris-run/current-state.json";
  const legacyPath = ".polaris/runs/current-state.json";

  if (normalizedPath.endsWith(debugPath)) {
    process.stderr.write(
      `finalize aborted: state file at compatibility/debug path — ${stateFile}\n` +
      `Canonical state files must be at .polaris/clusters/<cluster-id>/state.json or custom path.\n`,
    );
    process.exit(1);
  }

  if (normalizedPath.endsWith(legacyPath)) {
    process.stderr.write(
      `finalize aborted: state file at legacy path — ${stateFile}\n` +
      `Canonical state files must be at .polaris/clusters/<cluster-id>/state.json or custom path.\n`,
    );
    process.exit(1);
  }
}

/**
 * Ensures the cluster identifier is reflected in the current git branch name.
 *
 * Normalizes `clusterId` to a slug and compares it against a normalized `branch`; if the branch does not contain the slug,
 * writes an explanatory error to stderr and terminates the process with exit code 1.
 *
 * @param clusterId - The cluster identifier from state (e.g., `state.cluster_id`)
 * @param branch - The current git branch name
 */
function validateClusterIdMatchesBranch(clusterId: string, branch: string): void {
  const clusterSlug = extractClusterSlug(clusterId);
  const normalizedBranch = normalizeBranchName(branch);

  if (!normalizedBranch.includes(clusterSlug)) {
    process.stderr.write(
      `finalize aborted: cluster_id mismatch — state.cluster_id "${clusterId}" ` +
      `does not match current branch "${branch}".\n` +
      `Expected branch to contain slug "${clusterSlug}" (normalized from "${clusterId}").\n`,
    );
    process.exit(1);
  }
}

/**
 * Ensures the branch recorded in the state file matches the current git branch.
 *
 * If `stateBranch` is missing or empty, no check is performed. If `stateBranch`
 * is present and does not equal `branch`, the process is terminated with exit
 * code 1 after writing a descriptive error to stderr.
 *
 * @param stateBranch - The branch value read from the state file (may be undefined)
 * @param branch - The current git branch name
 */
function validateStateBranchMatchesGitBranch(stateBranch: string | undefined, branch: string): void {
  if (!stateBranch || stateBranch.trim() === "") {
    return;
  }

  if (stateBranch !== branch) {
    process.stderr.write(
      `finalize aborted: state.branch mismatch — state.branch "${stateBranch}" ` +
      `does not match current git branch "${branch}".\n`,
    );
    process.exit(1);
  }
}

/**
 * Execute the full finalize pipeline for a Polaris run: validate map and state, run configured checks
 * and canon/integrity gates, optionally reconcile trackers, commit durable state, push/create PR,
 * update trackers/telemetry, and archive the run.
 *
 * @param options - Finalize options
 * @param options.repoRoot - Filesystem path to the repository root
 * @param options.stateFile - Path to the current-state.json file to load and update
 * @param options.dryRun - If true, run validations and report generation but skip commits, pushes, and delivery
 * @param options.skipDelivery - If true, perform validation and commit steps but skip push/PR/delivery-related actions
 */
export async function runFinalize(options: FinalizeOptions): Promise<void> {
  const { repoRoot, stateFile, dryRun, skipDelivery } = options;
  const config = loadConfig(repoRoot);

  // Step 1: polaris map update --changed
  console.log("[1/13] Updating map..."); // Step count updated
  stepMapUpdate(repoRoot);

  // Step 2: polaris map validate — fail fast
  console.log("[2/13] Validating map..."); // Step count updated
  stepMapValidate(repoRoot);

  // Step 3: Validate current-state.json schema
  console.log("[3/13] Validating current-state.json schema..."); // Step count updated
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

  // Preflight: state file authority gate (must run before Step 4)
  const branch = getBranch(repoRoot);
  validateStateFilePath(stateFile);
  validateClusterIdMatchesBranch(state.cluster_id, branch);
  validateStateBranchMatchesGitBranch(state.branch, branch);

  // Step 4: Run configured checks
  const checks = config.finalize?.runChecks ?? [];
  if (checks.length > 0) {
    console.log(`[4/13] Running ${checks.length} configured check(s) and staging preflight...`); // Step count updated
  } else {
    console.log("[4/13] Running staging preflight..."); // Step count updated
  }
  stepRunChecks(repoRoot, checks, { activeClusterId: state.cluster_id, skipDelivery });

  // Step 4.5: Canon reconciliation check
  const canonCheckEnabled = config.canon?.checkOnFinalize !== false;
  if (canonCheckEnabled) {
    console.log("[4.5/13] Running canon reconciliation check..."); // Step count updated
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

    const artifactDirForCheck = state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
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
  console.log("[5/13] Generating run-report.md..."); // Step count updated
  const reportPath = stepGenerateReport(repoRoot, state, branch, true);

  if (dryRun) {
    console.log("[6–13/13] Dry run — skipping reconciliation, commit and delivery."); // Step count updated
    console.log("Finalize dry run complete.");
    return;
  }

  // Step 5.5: Implementation evidence gate
  // Require at least one non-artifact staged file before committing. A finalize
  // commit with only Polaris artifact files means no real implementation work
  // was recorded — abort to prevent a phantom delivery.
  {
    const stagedOutput = execFileSync("git", ["diff", "--cached", "--name-only"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    const stagedFiles = stagedOutput ? stagedOutput.split("\n").filter(Boolean) : [];
    const implFiles = stagedFiles.filter(
      (f) => classifyArtifactPath(f, state.cluster_id) === "non-artifact",
    );
    if (implFiles.length === 0) {
      const evidenceReport = verifyCompletedChildFinalizeEvidence(repoRoot, stateFile);
      if (!evidenceReport.ok) {
        process.stderr.write(
          "finalize aborted: No implementation evidence found. " +
          "No non-artifact source files are staged and canonical completed-child evidence failed.\n" +
          `${formatFinalizeEvidenceFailures(evidenceReport.failures)}\n`,
        );
        process.exit(1);
      }
    }
  }

  // Step 5.6: Branch custody verification
  // When the cluster state records a delivery_branch and base_branch (set by dispatch),
  // verify that base..delivery_branch contains at least one non-artifact source change
  // and that no completed child's commit is already reachable from the base branch.
  //
  // Skipped when no custody record is present (backward compatibility with runs
  // that did not go through the custody-aware dispatch path) or when
  // loop.allowBranchDivergence is true (direct-main mode).
  {
    const clusterState = readClusterStateSync(state.cluster_id, repoRoot);
    const baseBranch = clusterState?.base_branch;
    const deliveryBranch = clusterState?.delivery_branch;
    const directMainMode = config.loop?.allowBranchDivergence === true;

    if (!directMainMode && baseBranch && deliveryBranch) {
      // Assert finalize is running on the recorded delivery branch.
      if (branch !== deliveryBranch) {
        process.stderr.write(
          `finalize aborted: branch custody violation — not on delivery branch. ` +
            `Expected "${deliveryBranch}", got "${branch}".\n`,
        );
        process.exit(1);
      }

      const hasImplChanges = hasNonArtifactSourceChanges(
        repoRoot,
        baseBranch,
        state.cluster_id,
        deliveryBranch,
      );
      if (!hasImplChanges) {
        process.stderr.write(
          `finalize aborted: branch custody violation — no non-artifact source changes found in ` +
            `${baseBranch}...${deliveryBranch}. Child commits may already be on the base branch, ` +
            `or no implementation work was recorded on this delivery branch.\n`,
        );
        process.exit(1);
      }

      // Check each completed child's commit to verify it is not already on the base branch.
      for (const childId of state.completed_children) {
        const commitHash =
          clusterState.commits?.[childId] ??
          state.completed_children_results?.[childId]?.commit ??
          null;
        if (!commitHash) continue;
        const custodyError = verifyChildCommitCustody(
          repoRoot,
          commitHash,
          deliveryBranch,
          baseBranch,
        );
        if (custodyError) {
          process.stderr.write(
            `finalize aborted: branch custody violation for ${childId}: ${custodyError}\n`,
          );
          process.exit(1);
        }
      }
    }
  }

  // Step 5.7: Unconditional delivery integrity gate
  // Verifies the delivery branch contains actual implementation work relative to the base branch.
  // Runs regardless of whether branch custody records were established in cluster state,
  // closing the gap that allowed PR #93 to claim delivery when implementation was already on main.
  {
    const directMainMode = config.loop?.allowBranchDivergence === true;
    if (!directMainMode) {
      const clusterStateForIntegrity = readClusterStateSync(state.cluster_id, repoRoot);
      const integrityBaseBranch =
        clusterStateForIntegrity?.base_branch ??
        config.finalize?.targetBranch ??
        "main";

      const childCommits: Record<string, string> = {};
      for (const childId of state.completed_children) {
        const commit =
          clusterStateForIntegrity?.commits?.[childId] ??
          state.completed_children_results?.[childId]?.commit ??
          null;
        if (commit) childCommits[childId] = commit;
      }

      const integrityResult = validateDeliveryIntegrity({
        repoRoot,
        currentBranch: branch,
        baseBranch: integrityBaseBranch,
        clusterId: state.cluster_id,
        completedChildren: state.completed_children,
        childCommits,
      });

      if (!integrityResult.ok) {
        process.stderr.write(
          `finalize aborted: delivery integrity check failed (${integrityResult.kind}) — ${integrityResult.reason}\n`,
        );
        process.exit(1);
      }
    }
  }

  // Step 6: Tracker Reconciliation
  // LinearAdapter is sync-in only; only McpBridgeAdapter supports full reconciliation.
  const trackerType = config.tracker?.adapter;
  if (!trackerType) {
    console.log("[6/13] Tracker not configured — skipping reconciliation.");
  } else if (trackerType === "linear") {
    console.log("[6/13] Linear adapter is sync-in only — skipping reconciliation (use mcp-bridge for two-way sync).");
  } else if (trackerType === "mcp-bridge") {
    console.log("[6/13] Running tracker reconciliation...");
    try {
      const localGraph = await LocalGraph.load(state.cluster_id, repoRoot);
      const { McpBridgeAdapter } = await import("../tracker/adapters/mcp-bridge.js");
      const trackerAdapter = new McpBridgeAdapter();
      const trackerSyncService = new TrackerSyncService(trackerAdapter, localGraph, {
        repoRoot,
        clusterId: state.cluster_id,
      });
      await trackerSyncService.ready;
      const reconciliationReport = await trackerSyncService.reconcile(dryRun);
      console.log("Tracker Reconciliation Report:", reconciliationReport);
      if (reconciliationReport.conflictsDetectedCount > 0 || reconciliationReport.failedMutationsCount > 0) {
        const summary = reconciliationReport.details.join(" | ");
        throw new Error(
          `tracker reconciliation requires attention (conflicts=${reconciliationReport.conflictsDetectedCount}, failed=${reconciliationReport.failedMutationsCount})${summary ? `: ${summary}` : ""}`,
        );
      }
    } catch (error) {
      console.error("Error during tracker reconciliation:", error);
      process.stderr.write(`finalize aborted: tracker reconciliation failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  } else {
    console.warn(`[6/13] Unknown tracker adapter '${trackerType}' — skipping reconciliation.`);
  }

  // Step 7: Single final commit: source changes + durable Polaris artifacts
  console.log("[7/13] Committing durable Polaris state + map..."); // Step count updated
  const resolvedStateFile = resolve(stateFile);
  stepCommit(repoRoot, state, resolvedStateFile, reportPath);

  if (skipDelivery) {
    console.log("[8–13/13] Delivery skipped (--skip-delivery)."); // Step count updated
    console.log("polaris finalize steps 1–7 complete."); // Step count updated
    return;
  }

  // Step 8: git push
  console.log("[8/13] Pushing branch..."); // Step count updated
  stepPush(repoRoot, branch);

  // Step 9: Create draft PR
  const prDraft = config.finalize?.prDraft ?? true;
  console.log("[9/13] Creating draft PR..."); // Step count updated
  const prUrl = stepCreatePr(repoRoot, branch, state, prDraft);

  // Step 10: Write PR URL to current-state.json
  console.log("[10/13] Writing PR URL to state..."); // Step count updated
  state = stepUpdateState(resolvedStateFile, state, prUrl);

  // Step 11: Append JSONL events
  console.log("[11/13] Appending JSONL events..."); // Step count updated
  const artifactDir = state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
  stepAppendJsonl(telemetryFile, state, prUrl);

  // Step 12: Update Linear parent issue
  console.log("[12/13] Updating Linear..."); // Step count updated
  const linearEnabled = config.tracker?.linear?.enabled ?? false;
  await stepUpdateLinear(state, branch, prUrl, true, linearEnabled, state.cluster_id);

  // Step 13: Archive run snapshot
  console.log("[13/13] Archiving run snapshot..."); // Step count updated
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
