import { execFileSync } from "node:child_process";
import { classifyArtifactPath } from "../finalize/artifact-policy.js";
import { posix as pathPosix } from "node:path";

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
 * Creates and switches to `branchName`, or switches to it if it already exists.
 * Checks for branch existence explicitly before choosing the git operation so
 * that errors from unrelated failures are not silently swallowed.
 * Throws with context when the checkout fails.
 */
export function ensureDeliveryBranch(repoRoot: string, branchName: string): void {
  const branchExists = (() => {
    try {
      execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  })();

  const args = branchExists ? ["checkout", branchName] : ["checkout", "-b", branchName];
  try {
    execFileSync("git", args, { cwd: repoRoot, stdio: "pipe" });
  } catch (err) {
    const stderr =
      err instanceof Error && "stderr" in err ? String((err as NodeJS.ErrnoException & { stderr: unknown }).stderr).trim() : "";
    throw new Error(
      `ensureDeliveryBranch: git ${args.join(" ")} failed` +
        (stderr ? `: ${stderr}` : "") +
        ` (branch="${branchName}", repoRoot="${repoRoot}")`,
    );
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
  } catch (err) {
    throw new Error(
      `hasNonArtifactSourceChanges: git diff failed for ${baseBranch}...${deliveryBranch}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

export interface CustodyRecord {
  base_branch: string;
  base_sha: string;
  delivery_branch: string;
}

export interface WorkerCommitScopeViolation {
  path: string;
  kind: "prohibited" | "out-of-scope";
  pattern: string;
}

export interface WorkerCommitScopeCheck {
  staged_files: string[];
  violations: WorkerCommitScopeViolation[];
}

function normalizeCommitPath(filePath: string): string {
  return pathPosix.normalize(filePath.replace(/\\/g, "/")).replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function globPatternToRegExp(pattern: string): RegExp {
  let re = "^";
  const normalized = normalizeCommitPath(pattern);
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      re += "[^/]";
      continue;
    }
    re += escapeRegExp(char);
  }
  re += "$";
  return new RegExp(re);
}

function patternMatchesPath(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizeCommitPath(pattern);
  const normalizedPath = normalizeCommitPath(filePath);

  if (/[\\*?\[\]]/.test(normalizedPattern)) {
    return globPatternToRegExp(normalizedPattern).test(normalizedPath);
  }

  if (normalizedPattern.endsWith("/")) {
    return normalizedPath.startsWith(normalizedPattern);
  }

  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function getStagedFiles(repoRoot: string): string[] {
  const output = execFileSync(
    "git",
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    { cwd: repoRoot, encoding: "utf-8" },
  ).trim();
  if (!output) {
    return [];
  }
  return output.split("\n").map((line) => normalizeCommitPath(line)).filter(Boolean);
}

export function validateWorkerCommitScope(
  repoRoot: string,
  allowedScope: string[],
  prohibitedWritePaths: string[],
): WorkerCommitScopeCheck {
  const stagedFiles = getStagedFiles(repoRoot);
  const violations: WorkerCommitScopeViolation[] = [];

  for (const stagedFile of stagedFiles) {
    const prohibitedPattern = prohibitedWritePaths.find((pattern) => patternMatchesPath(pattern, stagedFile));
    if (prohibitedPattern) {
      violations.push({
        path: stagedFile,
        kind: "prohibited",
        pattern: prohibitedPattern,
      });
      continue;
    }

    const allowedPattern = allowedScope.find((pattern) => patternMatchesPath(pattern, stagedFile));
    if (!allowedPattern) {
      violations.push({
        path: stagedFile,
        kind: "out-of-scope",
        pattern: allowedScope.length > 0 ? allowedScope[0]! : "",
      });
    }
  }

  return { staged_files: stagedFiles, violations };
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
