import { execFileSync } from "node:child_process";
import { classifyArtifactPath } from "../finalize/artifact-policy.js";

export const PROTECTED_BASE_BRANCHES = new Set([
  "main",
  "master",
  "dev",
  "develop",
  "staging",
  "production",
  "release",
]);

export class BranchCustodyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BranchCustodyViolation";
  }
}

/** Returns true when branchName is a known protected base branch. */
export function isProtectedBranch(branchName: string): boolean {
  return PROTECTED_BASE_BRANCHES.has(branchName.toLowerCase());
}

/** Returns the SHA for a ref, or null when the ref cannot be resolved. */
export function getRefSha(repoRoot: string, ref: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", ref], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Returns true when `commit` is an ancestor of (or equal to) `ref`.
 * Uses `git merge-base --is-ancestor` which exits 0 on success.
 */
export function isCommitReachableFrom(
  repoRoot: string,
  commit: string,
  ref: string,
): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", commit, ref], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Throws BranchCustodyViolation when currentBranch is a protected base branch.
 * Implementation workers must run on a delivery branch, never on main/master/etc.
 */
export function assertNotOnBaseBranch(currentBranch: string): void {
  if (isProtectedBranch(currentBranch)) {
    throw new BranchCustodyViolation(
      `Branch custody violation: workers must not run on base branch "${currentBranch}". ` +
        `Create a delivery branch before dispatching implementation workers.`,
    );
  }
}

/**
 * Throws BranchCustodyViolation when currentBranch differs from the
 * delivery branch that was recorded for this cluster at first dispatch.
 */
export function assertDeliveryBranchMatch(
  currentBranch: string,
  deliveryBranch: string,
): void {
  if (currentBranch !== deliveryBranch) {
    throw new BranchCustodyViolation(
      `Branch custody violation: current branch "${currentBranch}" does not match ` +
        `recorded delivery branch "${deliveryBranch}". ` +
        `Switch to the delivery branch before dispatching.`,
    );
  }
}

/**
 * Verifies that a child commit belongs to the delivery branch and has not yet
 * been merged into the base branch.
 *
 * Returns null on success, or a human-readable error string on failure.
 */
export function verifyChildCommitCustody(
  repoRoot: string,
  commit: string,
  deliveryBranch: string,
  baseBranch: string,
): string | null {
  const onDelivery = isCommitReachableFrom(repoRoot, commit, deliveryBranch);
  if (!onDelivery) {
    return (
      `commit ${commit} is not reachable from delivery branch "${deliveryBranch}"`
    );
  }
  const onBase = isCommitReachableFrom(repoRoot, commit, baseBranch);
  if (onBase) {
    return (
      `commit ${commit} is already reachable from base branch "${baseBranch}" ` +
      `(branch custody violation: implementation committed directly to base)`
    );
  }
  return null;
}

/**
 * Returns the canonical delivery branch name for a cluster.
 * e.g. "POL-268" → "pol-268-delivery"
 */
export function buildDeliveryBranchName(clusterId: string): string {
  return clusterId.toLowerCase().replace(/_/g, "-") + "-delivery";
}

/**
 * Creates and switches to `branchName` (git checkout -b).
 * If the branch already exists, switches to it instead (git checkout).
 * Throws when both operations fail.
 */
export function ensureDeliveryBranch(repoRoot: string, branchName: string): void {
  try {
    execFileSync("git", ["checkout", "-b", branchName], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    execFileSync("git", ["checkout", branchName], { cwd: repoRoot, stdio: "ignore" });
  }
}

/**
 * Returns true when the range baseBranch...deliveryBranch contains at least
 * one non-artifact source file change (i.e. a real implementation change beyond
 * Polaris artifacts).
 *
 * Pass the explicit delivery branch ref so the comparison is independent of
 * the current HEAD position.
 *
 * Files under .polaris/ and .taskchain_artifacts/ are not counted as
 * implementation evidence.
 */
export function hasNonArtifactSourceChanges(
  repoRoot: string,
  baseBranch: string,
  clusterId: string,
  deliveryBranch: string,
): boolean {
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${baseBranch}...${deliveryBranch}`],
      { cwd: repoRoot, encoding: "utf-8" },
    ).trim();
    if (!output) return false;
    const changedFiles = output.split("\n").filter(Boolean);
    return changedFiles.some(
      (f) => classifyArtifactPath(f, clusterId) === "non-artifact",
    );
  } catch {
    return false;
  }
}

export interface CustodyRecord {
  base_branch: string;
  base_sha: string;
  delivery_branch: string;
}

/**
 * Builds a custody record from the current repo state.
 * base_sha captures the tip of baseBranch at the moment custody is established.
 */
export function buildCustodyRecord(
  repoRoot: string,
  currentBranch: string,
  baseBranch = "main",
): CustodyRecord {
  const baseSha = getRefSha(repoRoot, baseBranch) ?? getRefSha(repoRoot, "HEAD") ?? "unknown";
  return {
    base_branch: baseBranch,
    base_sha: baseSha,
    delivery_branch: currentBranch,
  };
}
