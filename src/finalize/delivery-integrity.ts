import { execFileSync } from "node:child_process";
import { classifyArtifactPath } from "./artifact-policy.js";
import { isCommitReachableFrom } from "../loop/git-custody.js";

/**
 * Describes why a delivery integrity check failed.
 *
 * - "impl-already-on-base": all recorded child commits are already reachable from the
 *   base branch — the classic PR #93 failure mode where implementation landed on main
 *   before finalization ran.
 * - "artifact-only": branch diff (committed + staged) contains only Polaris runtime
 *   artifacts, with no implementation source files.
 * - "map-only": branch diff contains only .polaris/map/ artifacts.
 * - "telemetry-only": branch diff contains only run-ledger / telemetry files.
 * - "runtime-artifacts-only": branch diff contains only a mix of runtime artifacts
 *   (cluster artifacts, map, telemetry) but no source files.
 * - "empty-branch": no changes at all between base branch and delivery (including staged).
 */
export type DeliveryIntegrityFailureKind =
  | "impl-already-on-base"
  | "artifact-only"
  | "map-only"
  | "telemetry-only"
  | "runtime-artifacts-only"
  | "empty-branch";

export type DeliveryIntegrityResult =
  | { ok: true }
  | { ok: false; kind: DeliveryIntegrityFailureKind; reason: string };

export interface DeliveryIntegrityOptions {
  repoRoot: string;
  /** Current HEAD branch being finalized. */
  currentBranch: string;
  /** Base branch the PR targets (e.g. "main"). */
  baseBranch: string;
  /** Active cluster ID for artifact classification. */
  clusterId: string;
  /** IDs of children recorded as completed in the run state. */
  completedChildren: string[];
  /**
   * Map of childId → commitHash from cluster-state and/or run-state.
   * Only children that have a recorded commit hash are checked against base.
   */
  childCommits: Record<string, string>;
}

function getBranchDiff(repoRoot: string, baseBranch: string, currentBranch: string): string[] {
  if (baseBranch === currentBranch) {
    return [];
  }
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${baseBranch}...${currentBranch}`],
      { cwd: repoRoot, encoding: "utf-8" },
    ).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch (err) {
    throw new Error(
      `delivery-integrity: git diff failed for ${baseBranch}...${currentBranch}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function getStagedFiles(repoRoot: string): string[] {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--cached", "--name-only"],
      { cwd: repoRoot, encoding: "utf-8" },
    ).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

interface ClassifiedFiles {
  impl: string[];
  map: string[];
  telemetry: string[];
  other: string[];
}

function classifyAll(files: string[], clusterId: string): ClassifiedFiles {
  const impl: string[] = [];
  const map: string[] = [];
  const telemetry: string[] = [];
  const other: string[] = [];

  for (const file of files) {
    const cls = classifyArtifactPath(file, clusterId);
    if (cls === "non-artifact") {
      impl.push(file);
    } else if (cls === "promoted-map-artifact") {
      map.push(file);
    } else if (cls === "promoted-run-ledger") {
      telemetry.push(file);
    } else {
      other.push(file);
    }
  }

  return { impl, map, telemetry, other };
}

/**
 * Validates that a finalization delivery actually contains implementation work.
 *
 * Checks the combined view of committed branch diff (baseBranch...currentBranch) and
 * currently staged files. This handles both the normal case (implementation already
 * committed to delivery branch by workers) and the edge case where implementation is
 * being staged as part of the finalize commit itself.
 *
 * Fails closed: if the check cannot confirm implementation delivery, it returns an
 * error result instead of passing.
 */
export function validateDeliveryIntegrity(
  opts: DeliveryIntegrityOptions,
): DeliveryIntegrityResult {
  const { repoRoot, currentBranch, baseBranch, clusterId, completedChildren, childCommits } = opts;

  // Combine committed branch diff with staged files to capture the full delivery picture.
  // Workers commit implementation during execution; the finalize commit adds artifacts.
  // Either source of non-artifact files is valid evidence of real implementation work.
  const committedFiles = getBranchDiff(repoRoot, baseBranch, currentBranch);
  const stagedFiles = getStagedFiles(repoRoot);
  const allFiles = [...new Set([...committedFiles, ...stagedFiles])];

  const classified = classifyAll(allFiles, clusterId);

  if (classified.impl.length > 0) {
    return { ok: true };
  }

  // No implementation source files found. Determine whether this is because
  // implementation is already on the base branch (PR #93 scenario) or because
  // the branch genuinely contains no implementation work.

  const childrenWithCommits = completedChildren.filter((id) => id in childCommits);
  const childrenAlreadyOnBase = childrenWithCommits.filter((id) => {
    const commit = childCommits[id]!;
    return isCommitReachableFrom(repoRoot, commit, baseBranch);
  });

  if (
    childrenWithCommits.length > 0 &&
    childrenAlreadyOnBase.length === childrenWithCommits.length
  ) {
    return {
      ok: false,
      kind: "impl-already-on-base",
      reason:
        `Implementation for completed children (${childrenAlreadyOnBase.join(", ")}) is already ` +
        `reachable from base branch "${baseBranch}". ` +
        `The delivery branch "${currentBranch}" contains no new implementation relative to "${baseBranch}". ` +
        `This PR would not deliver any implementation work — only leftover metadata.`,
    };
  }

  if (allFiles.length === 0) {
    return {
      ok: false,
      kind: "empty-branch",
      reason:
        `No changes found between "${baseBranch}" and "${currentBranch}" (including staged files). ` +
        `Nothing to deliver.`,
    };
  }

  // All changes are artifacts/metadata. Produce a specific error for each category
  // to make the failure reason immediately actionable.

  const hasMap = classified.map.length > 0;
  const hasTelemetry = classified.telemetry.length > 0;
  const hasOther = classified.other.length > 0;

  const fileList = (files: string[], max = 3): string =>
    files.slice(0, max).join(", ") + (files.length > max ? ` (and ${files.length - max} more)` : "");

  if (hasMap && !hasTelemetry && !hasOther) {
    return {
      ok: false,
      kind: "map-only",
      reason:
        `The delivery branch "${currentBranch}" contains only Polaris map artifact changes ` +
        `(${fileList(classified.map)}) relative to "${baseBranch}". ` +
        `No implementation source files were found. This PR would deliver only metadata.`,
    };
  }

  if (hasTelemetry && !hasMap && !hasOther) {
    return {
      ok: false,
      kind: "telemetry-only",
      reason:
        `The delivery branch "${currentBranch}" contains only telemetry/ledger changes ` +
        `(${fileList(classified.telemetry)}) relative to "${baseBranch}". ` +
        `No implementation source files were found. This PR would deliver only telemetry.`,
    };
  }

  if (!hasOther) {
    return {
      ok: false,
      kind: "runtime-artifacts-only",
      reason:
        `The delivery branch "${currentBranch}" contains only runtime artifact changes ` +
        `(map: ${classified.map.length}, telemetry: ${classified.telemetry.length} file(s)) ` +
        `relative to "${baseBranch}". No implementation source files were found.`,
    };
  }

  return {
    ok: false,
    kind: "artifact-only",
    reason:
      `The delivery branch "${currentBranch}" contains only artifact/metadata changes ` +
      `(${fileList(allFiles, 5)}) relative to "${baseBranch}". ` +
      `No implementation source files were found. This PR would not deliver any implementation work.`,
  };
}
