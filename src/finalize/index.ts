import { Command } from "commander";
import { join, resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  checkLibrarianResultGate,
  validateCloseoutLibrarianResult,
  type CloseoutLibrarianResult,
} from "../cognition/closeout-librarian-types.js";
import { loadConfig } from "../config/loader.js";
import type { QcConfig } from "../config/schema.js";
import { readState, type LoopState } from "../loop/checkpoint.js";
import { classifyArtifactPath } from "./artifact-policy.js";
import { hasNonArtifactSourceChanges, verifyChildCommitCustody, patternMatchesPath } from "../loop/git-custody.js";
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
import { runQcAtTrigger, createQcRegistry } from "../qc/index.js";

export interface FinalizeOptions {
  repoRoot: string;
  stateFile: string;
  dryRun?: boolean;
  skipDelivery?: boolean;
  skipLibrarian?: boolean;
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

function normalizeBranchName(branch: string): string {
  return branch.toLowerCase().replace(/[_/]/g, "-");
}

function extractClusterSlug(clusterId: string): string {
  const match = clusterId.match(/([A-Z]+-\d+)/);
  return match ? normalizeBranchName(match[1]) : normalizeBranchName(clusterId);
}

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

function validateClusterIdMatchesBranch(clusterId: string, branch: string): void {
  const clusterSlug = extractClusterSlug(clusterId);
  const normalizedBranch = normalizeBranchName(branch);

  const slugPattern = new RegExp(`(^|-)${clusterSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-|$)`);
  if (!slugPattern.test(normalizedBranch)) {
    process.stderr.write(
      `finalize aborted: cluster_id mismatch — state.cluster_id "${clusterId}" ` +
      `does not match current branch "${branch}".\n` +
      `Expected branch to contain slug "${clusterSlug}" (normalized from "${clusterId}").\n`,
    );
    process.exit(1);
  }
}

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
 * Check that the Closeout Librarian has run and its result passes the gate.
 * Returns null if finalize may proceed; returns a human-readable blocker string if not.
 */
function checkLibrarianGate(repoRoot: string, clusterId: string): string | null {
  const packetsDir = join(repoRoot, ".polaris", "clusters", clusterId, "packets");

  let packetFiles: string[] = [];
  try {
    packetFiles = readdirSync(packetsDir)
      .filter((f) => f.startsWith("librarian-packet-") && f.endsWith(".json"))
      .sort();
  } catch {
    // directory absent — no packet has been generated
  }

  const latestPacket = packetFiles
    .map((file) => join(packetsDir, file))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return b.localeCompare(a);
      }
    })[0];
  if (!latestPacket) {
    return (
      "Closeout Librarian has not been dispatched for this cluster.\n" +
      `  1. Generate packet:  npx polaris librarian packet ${clusterId} --state-file <state-file>\n` +
      `  2. Dispatch the Librarian with the generated packet path as the sole session prompt.\n` +
      `  3. Wait for the Librarian to write its sealed result.\n` +
      `  4. Re-run finalize.\n` +
      `Use --skip-librarian to bypass this gate for backward compatibility.`
    );
  }
  let packetJson: Record<string, unknown>;
  try {
    packetJson = JSON.parse(readFileSync(latestPacket, "utf-8")) as Record<string, unknown>;
  } catch {
    return `Cannot read Librarian packet at ${latestPacket}. Regenerate with: npx polaris librarian packet ${clusterId}`;
  }

  const resultPath = packetJson["result_path"];
  if (typeof resultPath !== "string") {
    return `Librarian packet is malformed: missing result_path. Regenerate with: npx polaris librarian packet ${clusterId}`;
  }

  if (!existsSync(resultPath)) {
    return (
      "Closeout Librarian has not written its sealed result yet.\n" +
      `  Expected result at: ${resultPath}\n` +
      `  Dispatch the Librarian session and wait for it to write its sealed result, then re-run finalize.`
    );
  }

  let resultJson: unknown;
  try {
    resultJson = JSON.parse(readFileSync(resultPath, "utf-8"));
  } catch {
    return `Cannot read Librarian result at ${resultPath}. The file may be corrupt.`;
  }

  const validationErrors = validateCloseoutLibrarianResult(resultJson);
  if (validationErrors.length > 0) {
    return `Librarian result is invalid: ${validationErrors.join("; ")}`;
  }

  // Cross-validate dispatch_id and run_id
  const result = resultJson as CloseoutLibrarianResult;
  if (packetJson["dispatch_id"] !== result.dispatch_id) {
    return `Librarian result dispatch_id mismatch (packet: ${packetJson["dispatch_id"]}, result: ${result.dispatch_id}). Regenerate and re-dispatch.`;
  }
  if (packetJson["run_id"] !== result.run_id) {
    return `Librarian result run_id mismatch (packet: ${packetJson["run_id"]}, result: ${result.run_id}).`;
  }

  // Validate files_committed against packet scope constraints.
  // allowed_write_paths and prohibited_write_paths in the packet are absolute paths.
  // files_committed in the result are repo-relative paths (git output). Resolve each
  // to absolute before comparing so the patterns match correctly.
  const allowedWritePaths = (packetJson["allowed_write_paths"] ?? []) as string[];
  const prohibitedWritePaths = (packetJson["prohibited_write_paths"] ?? []) as string[];
  const filesCommitted = result.files_committed ?? [];

  for (const file of filesCommitted) {
    const absFile = resolve(repoRoot, file);

    // Allowed takes precedence over prohibited — a specific allowed path wins over a broad prohibition.
    const allowedMatch = allowedWritePaths.find((pattern) => patternMatchesPath(pattern, absFile));
    if (allowedMatch) continue;

    const prohibitedMatch = prohibitedWritePaths.find((pattern) => patternMatchesPath(pattern, absFile));
    if (prohibitedMatch) {
      return `Librarian wrote to prohibited path: ${file} (matched pattern: ${prohibitedMatch})`;
    }

    return `Librarian wrote to out-of-scope path: ${file} (not in allowed_write_paths)`;
  }

  try {
    return checkLibrarianResultGate(result);
  } catch (err) {
    return `Librarian result gate error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function resolveQcTelemetryFile(state: LoopState, repoRoot: string): string {
  const artifactDir = state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  return join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
}

// ── QC repair-loop terminal state gate ────────────────────────────────────────

/**
 * Trusted QC repair-loop terminal outcomes that allow finalize to proceed.
 * "pass" = QC rerun passed; "qc-disabled" = QC was off; "no-repairable" = no
 * findings routable to repair workers (follow-up-only or already resolved).
 */
const TRUSTED_QC_REPAIR_OUTCOMES = new Set(["pass", "qc-disabled", "no-repairable"]);

/**
 * Validate QC repair-loop terminal state when QC is enabled and repair routing
 * is active. Returns null when finalize may proceed; returns a human-readable
 * blocker string otherwise.
 */
export function validateQcRepairLoopGate(
  state: LoopState,
  config: QcConfig,
): string | null {
  // Gate only applies when QC is enabled
  if (!config.enabled) return null;

  // Gate only applies when repair routing is active (not "log" or "block")
  const repairRouting = config.repairRouting ?? "route";
  if (repairRouting !== "route" && repairRouting !== "follow-up") return null;

  const repairLoop = state.qc_repair_loop;

  // No repair-loop state at all — the completed-cluster QC trigger ran but
  // never entered the repair loop. This is a gap: finalize should not proceed.
  if (!repairLoop) {
    return (
      "QC is enabled with repair routing active, but no qc_repair_loop state " +
      "was found in the run state. The parent loop must run the QC repair loop " +
      "before finalize can proceed."
    );
  }

  const outcome = repairLoop.terminal_outcome;

  if (outcome === null || outcome === undefined) {
    return (
      "QC repair loop is still in-flight (terminal_outcome is null). " +
      "Finalize cannot proceed until the repair loop reaches a terminal state."
    );
  }

  if (TRUSTED_QC_REPAIR_OUTCOMES.has(outcome)) return null;

  return (
    `QC repair loop terminated with untrusted outcome: "${outcome}". ` +
    `Only ${Array.from(TRUSTED_QC_REPAIR_OUTCOMES).join(", ")} outcomes allow finalize to proceed. ` +
    `Resolve the repair loop before re-running finalize.`
  );
}

// ── Authoritative completed-child state cross-check ───────────────────────────

export interface AuthoritativeChildResult {
  ok: boolean;
  /** Authoritative completed-child count from cluster-state child_states. */
  authoritativeCount: number;
  /** Count from the loop state's completed_children array. */
  stateCount: number;
  reason?: string;
}

/**
 * Cross-check completed children in the loop state against the cluster-state
 * child_states. Returns a diagnostic result — when `ok` is false, finalize
 * should refuse PR creation.
 */
export function validateAuthoritativeChildState(
  state: LoopState,
  repoRoot: string,
): AuthoritativeChildResult {
  const clusterState = readClusterStateSync(state.cluster_id, repoRoot);
  const stateCount = state.completed_children.length;

  // No cluster state available — backward-compat: trust the loop state.
  if (!clusterState) {
    return { ok: true, authoritativeCount: stateCount, stateCount };
  }

  const childStates = clusterState.child_states;

  // No child_states array in cluster state — backward-compat: trust the loop state.
  // This covers legacy cluster-state files that don't track individual child lifecycle.
  if (!childStates || childStates.length === 0) {
    return { ok: true, authoritativeCount: stateCount, stateCount };
  }

  const doneChildren = childStates.filter(
    (c) => c.status === "done" || c.status === "reviewed" || c.status === "finalized",
  );
  const authoritativeCount = doneChildren.length;

  // When cluster-state has tracked children but zero are done while loop state
  // claims completions, the cluster state file is stale or was never updated.
  if (authoritativeCount === 0 && stateCount > 0) {
    return {
      ok: false,
      authoritativeCount,
      stateCount,
      reason:
        `Stale cluster state: cluster-state.json has 0 done children but ` +
        `loop state claims ${stateCount} completed. ` +
        `The cluster state file was never updated by worker completions.`,
    };
  }

  // Significant mismatch: cluster-state has fewer done children than loop state
  if (authoritativeCount < stateCount) {
    return {
      ok: false,
      authoritativeCount,
      stateCount,
      reason:
        `Completed-child count mismatch: cluster-state has ${authoritativeCount} done ` +
        `children but loop state has ${stateCount}. ` +
        `The cluster state may be stale or child completions were not recorded properly.`,
    };
  }

  return { ok: true, authoritativeCount, stateCount };
}

async function runQcGate(options: {
  config: QcConfig;
  state: LoopState;
  repoRoot: string;
  branch: string;
  baseRef?: string;
  trigger: "pr" | "completed-cluster" | "child";
  prUrl?: string;
  stepLabel: string;
}): Promise<void> {
  const { config, state, repoRoot, branch, baseRef, trigger, prUrl, stepLabel } = options;
  const registry = createQcRegistry(config);
  const result = await runQcAtTrigger({
    config,
    registry,
    trigger,
    prUrl,
    repoRoot,
    runId: state.run_id,
    clusterId: state.cluster_id,
    branch,
    baseRef,
    telemetryFile: resolveQcTelemetryFile(state, repoRoot),
    state,
  });

  if (result.action === "pass") {
    console.log(`${stepLabel} QC ${trigger} passed: ${result.summary}`);
    return;
  }
  if (result.action === "follow-up") {
    console.warn(`${stepLabel} QC ${trigger} produced follow-up work: ${result.summary}`);
    return;
  }
  process.stderr.write(`${stepLabel} QC ${trigger} blocked finalize: ${result.summary}\n`);
  process.exit(1);
}

export async function runFinalize(options: FinalizeOptions): Promise<void> {
  const { repoRoot, stateFile, dryRun, skipDelivery, skipLibrarian } = options;
  const config = loadConfig(repoRoot);

  // Step 1: polaris map update --changed
  console.log("[1/14] Updating map..."); // Step count updated
  stepMapUpdate(repoRoot);

  // Step 2: polaris map validate — fail fast
  console.log("[2/14] Validating map..."); // Step count updated
  stepMapValidate(repoRoot);

  // Step 3: Validate current-state.json schema
  console.log("[3/14] Validating current-state.json schema..."); // Step count updated
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
    console.log(`[4/14] Running ${checks.length} configured check(s) and staging preflight...`); // Step count updated
  } else {
    console.log("[4/14] Running staging preflight..."); // Step count updated
  }
  stepRunChecks(repoRoot, checks, { activeClusterId: state.cluster_id, skipDelivery });

  // Step 4.5: Canon reconciliation check
  const canonCheckEnabled = config.canon?.checkOnFinalize !== false;
  if (canonCheckEnabled) {
    console.log("[4.5/14] Running canon reconciliation check..."); // Step count updated
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
  console.log("[5/14] Generating run-report.md..."); // Step count updated
  const reportPath = stepGenerateReport(repoRoot, state, branch, true);

  if (dryRun) {
    console.log("[6–14/14] Dry run — skipping reconciliation, commit and delivery.");
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

  // Step 5.8: Completed-cluster QC trigger (when configured)
  // Runs after all authoritative gates and before final commit/delivery.
  const clusterStateForQc = readClusterStateSync(state.cluster_id, repoRoot);
  const qcBaseRef =
    clusterStateForQc?.base_branch ??
    config.finalize?.targetBranch ??
    "main";
  await runQcGate({
    config: config.qc,
    state,
    repoRoot,
    branch,
    baseRef: qcBaseRef,
    trigger: "completed-cluster",
    stepLabel: "[5.8/14]",
  });

  // Step 5.9: QC repair-loop terminal state gate
  // When QC is enabled and repair routing is active, require a trusted
  // terminal outcome from the QC repair loop before allowing PR creation.
  {
    const repairLoopBlocker = validateQcRepairLoopGate(state, config.qc);
    if (repairLoopBlocker) {
      process.stderr.write(
        `finalize aborted: QC repair-loop gate failed.\n${repairLoopBlocker}\n`,
      );
      process.exit(1);
    }
  }

  // Step 5.10: Authoritative completed-child state cross-check
  // Verify that the completed children claimed by the loop state match
  // the cluster-state child_states. Blocks on stale or inconsistent state.
  const authChildResult = validateAuthoritativeChildState(state, repoRoot);
  if (!authChildResult.ok) {
    process.stderr.write(
      `finalize aborted: authoritative child state mismatch.\n${authChildResult.reason}\n`,
    );
    process.exit(1);
  }

  // Step 6: Tracker Reconciliation
  // LinearAdapter is sync-in only; only McpBridgeAdapter supports full reconciliation.
  const trackerType = config.tracker?.adapter;
  if (!trackerType) {
    console.log("[6/14] Tracker not configured — skipping reconciliation.");
  } else if (trackerType === "linear") {
    console.log("[6/14] Linear adapter is sync-in only — skipping reconciliation (use mcp-bridge for two-way sync).");
  } else if (trackerType === "mcp-bridge") {
    console.log("[6/14] Running tracker reconciliation...");
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
    console.warn(`[6/14] Unknown tracker adapter '${trackerType}' — skipping reconciliation.`);
  }

  // Step 7: Closeout Librarian gate (pre-commit preflight)
  // Must run before the finalize commit so that a missing or invalid librarian
  // result aborts before any mutating git I/O.
  if (!skipDelivery) {
    if (!skipLibrarian) {
      console.log("[7/14] Checking Closeout Librarian gate...");
      const librarianBlocker = checkLibrarianGate(repoRoot, state.cluster_id);
      if (librarianBlocker) {
        process.stderr.write(`finalize aborted: Closeout Librarian gate failed.\n${librarianBlocker}\n`);
        process.exit(1);
      }
      console.log("[7/14] Closeout Librarian gate passed.");
    } else {
      console.log("[7/14] Closeout Librarian gate skipped (--skip-librarian).");
    }
  }

  // Step 8: Single final commit: source changes + durable Polaris artifacts
  console.log("[8/14] Committing durable Polaris state + map..."); // Step count updated
  const resolvedStateFile = resolve(stateFile);
  stepCommit(repoRoot, state, resolvedStateFile, reportPath);

  if (skipDelivery) {
    console.log("[9–14/14] Delivery skipped (--skip-delivery).");
    console.log("polaris finalize steps 1–8 complete.");
    return;
  }

  // Step 9: git push
  console.log("[9/14] Pushing branch...");
  stepPush(repoRoot, branch);

  // Step 10: Create draft PR
  const prDraft = config.finalize?.prDraft ?? true;
  console.log("[10/14] Creating draft PR...");
  const prUrl = stepCreatePr(repoRoot, branch, state, prDraft, authChildResult.authoritativeCount);

  // Step 10.5: PR-required QC trigger (when configured)
  // Providers that require a PR URL run here after the PR is created.
  await runQcGate({
    config: config.qc,
    state,
    repoRoot,
    branch,
    trigger: "pr",
    prUrl,
    stepLabel: "[10.5/14]",
  });

  // Step 11: Write PR URL to current-state.json
  console.log("[11/14] Writing PR URL to state...");
  state = stepUpdateState(resolvedStateFile, state, prUrl);

  // Step 12: Append JSONL events
  console.log("[12/14] Appending JSONL events...");
  const artifactDir = state.artifact_dir ?? join(repoRoot, ".taskchain_artifacts", "polaris-run");
  const telemetryFile = join(artifactDir, "runs", state.run_id, "telemetry.jsonl");
  stepAppendJsonl(telemetryFile, state, prUrl);

  // Step 13: Update Linear parent issue
  console.log("[13/14] Updating Linear...");
  const linearEnabled = config.tracker?.linear?.enabled ?? false;
  const lifecyclePolicy = config.tracker?.lifecyclePolicy;
  await stepUpdateLinear(state, branch, prUrl, true, linearEnabled, state.cluster_id, lifecyclePolicy, authChildResult.authoritativeCount);

  // Step 14: Archive run snapshot
  console.log("[14/14] Archiving run snapshot...");
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
    .option("--skip-librarian", "skip the Closeout Librarian gate (backward compatibility only)")
    .action((options: { repoRoot: string; stateFile?: string; dryRun?: boolean; skipDelivery?: boolean; skipLibrarian?: boolean }) => {
      const repoRoot = options.repoRoot;
      const stateFile =
        options.stateFile ??
        join(repoRoot, ".taskchain_artifacts", "polaris-run", "current-state.json");
      finalizeHandler({ repoRoot, stateFile, dryRun: options.dryRun, skipDelivery: options.skipDelivery, skipLibrarian: options.skipLibrarian })
        .catch((err: unknown) => {
          process.stderr.write(`finalize error: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        });
    });

  return finalize;
}
