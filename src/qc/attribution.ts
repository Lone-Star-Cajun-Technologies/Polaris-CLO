/**
 * QC attribution resolver.
 *
 * Correlates normalized QC findings to the child/worker most likely responsible
 * for the changed code. It uses durable evidence only: result packet pointers,
 * child commits, dispatch records, optional PR review metadata, and (as a
 * fallback) git history.
 */

import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { QcAttribution, QcFinding } from "./types.js";
import type { WorkerResultContract } from "../types/result-packet.js";
import type { ChildDispatchRecord } from "../loop/checkpoint.js";
import type { ClusterState } from "../cluster-state/types.js";

/** Optional PR review metadata used to disambiguate shared ownership. */
export interface QcPrReviewMetadata {
  /** Map reviewer id to files they commented on. */
  changedFilesByReviewer?: Record<string, string[]>;
  /** Files explicitly approved in the review. */
  approvedFiles?: string[];
}

/** Inputs the resolver can use to attribute a finding. */
export interface QcAttributionContext {
  /** Repository root for git fallbacks. */
  repoRoot?: string;
  /** Base branch used to compute which files a child changed. */
  baseBranch?: string;
  /** Pre-computed map of child id -> files that child changed. */
  changedFilesByChild?: Record<string, string[]>;
  /** Completed child results, keyed by child id. */
  completedResults?: Record<string, WorkerResultContract>;
  /** Dispatch records, keyed by child id. */
  dispatchRecords?: Record<string, ChildDispatchRecord>;
  /** Cluster state with commits and result pointers. */
  clusterState?: ClusterState;
  /** Optional PR review metadata. */
  prReviewMetadata?: QcPrReviewMetadata;
  /**
   * Provider confidence threshold. Findings whose provider confidence score is
   * below this value are marked provider-uncertain.
   */
  providerConfidenceThreshold?: number;
}

function normalizeFilePath(filePath: string | undefined, repoRoot?: string): string | null {
  if (!filePath) return null;
  const absolute = path.isAbsolute(filePath) ? filePath : path.join(repoRoot ?? process.cwd(), filePath);
  return path.relative(repoRoot ?? process.cwd(), absolute).replace(/\\/g, "/");
}

function collectResultChangedFiles(result: WorkerResultContract): string[] {
  if (result.changed_files && result.changed_files.length > 0) {
    return result.changed_files;
  }
  const fromData = result.result_data?.changed_files;
  if (Array.isArray(fromData) && fromData.every((f) => typeof f === "string")) {
    return fromData as string[];
  }
  return [];
}

function collectChangedFilesByChild(context: QcAttributionContext): Record<string, string[]> {
  if (context.changedFilesByChild) {
    return context.changedFilesByChild;
  }

  const ownership: Record<string, string[]> = {};

  if (context.completedResults) {
    for (const [childId, result] of Object.entries(context.completedResults)) {
      const files = collectResultChangedFiles(result);
      if (files.length > 0) {
        ownership[childId] = files.map((f) => normalizeFilePath(f, context.repoRoot)).filter((f): f is string => f !== null);
      }
    }
  }

  if (Object.keys(ownership).length > 0) {
    return ownership;
  }

  if (context.clusterState?.commits) {
    const base = context.baseBranch ?? "main";
    for (const [childId, commitSha] of Object.entries(context.clusterState.commits)) {
      const files = diffFilesForCommit(context.repoRoot, base, commitSha);
      if (files.length > 0) {
        ownership[childId] = files.map((f) => normalizeFilePath(f, context.repoRoot)).filter((f): f is string => f !== null);
      }
    }
  }

  return ownership;
}

function diffFilesForCommit(repoRoot: string | undefined, baseBranch: string, commitSha: string): string[] {
  if (!repoRoot) return [];
  try {
    const output = execFileSync(
      "git",
      ["diff", "--name-only", `${baseBranch}..${commitSha}`],
      { cwd: repoRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function ownersForFile(filePath: string, ownership: Record<string, string[]>): string[] {
  const owners: string[] = [];
  for (const [childId, files] of Object.entries(ownership)) {
    if (files.includes(filePath)) {
      owners.push(childId);
    }
  }
  return owners;
}

function isKnownChildCommit(commitSha: string | undefined, context: QcAttributionContext): boolean {
  if (!commitSha) return false;
  const commits = Object.values(context.clusterState?.commits ?? {});
  if (commits.includes(commitSha)) return true;
  if (context.completedResults) {
    return Object.values(context.completedResults).some((r) => r.commit === commitSha);
  }
  return false;
}

function isPreExistingFile(filePath: string, context: QcAttributionContext): boolean {
  if (!context.repoRoot) return false;
  try {
    execFileSync("git", ["cat-file", "-e", `HEAD:${filePath}`], {
      cwd: context.repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the most likely attribution for a finding.
 *
 * The resolver never fabricates confidence. When evidence is weak it falls
 * back to explicitly named reason codes so downstream routing can treat the
 * finding conservatively.
 */
export function resolveAttribution(finding: QcFinding, context: QcAttributionContext): QcAttribution {
  const threshold = context.providerConfidenceThreshold ?? 0.5;
  if (finding.confidence !== undefined && finding.confidence < threshold) {
    return {
      confidence: "low",
      reason: "provider-uncertain",
      filePath: normalizeFilePath(finding.filePath, context.repoRoot) ?? undefined,
      commitSha: finding.attribution?.commitSha ?? finding.commitSha,
    };
  }

  const filePath = normalizeFilePath(finding.filePath, context.repoRoot);
  if (!filePath) {
    return {
      confidence: "unattributed",
      reason: "provider-uncertain",
      commitSha: finding.attribution?.commitSha ?? finding.commitSha,
    };
  }

  const ownership = collectChangedFilesByChild(context);
  const owners = ownersForFile(filePath, ownership);

  const commitSha = finding.commitSha ?? finding.attribution?.commitSha;
  const commitKnown = isKnownChildCommit(commitSha, context);
  const commitMatchesOwner = commitSha && owners.some((childId) => {
    const childCommit = context.clusterState?.commits?.[childId] ?? context.completedResults?.[childId]?.commit;
    return childCommit === commitSha;
  });

  if (owners.length === 1) {
    const childId = owners[0];
    if (commitSha && !commitMatchesOwner) {
      return {
        confidence: "low",
        reason: "provider-uncertain",
        childId,
        filePath,
        commitSha,
      };
    }
    if (commitMatchesOwner) {
      return {
        confidence: "high",
        reason: "commit-line-match",
        childId,
        filePath,
        commitSha,
      };
    }
    return {
      confidence: "high",
      reason: "changed-file-owner",
      childId,
      filePath,
      commitSha,
    };
  }

  if (owners.length > 1) {
    return {
      confidence: "low",
      reason: "shared-file",
      childId: owners[0],
      filePath,
      commitSha,
    };
  }

  // File is not owned by any child. Use PR review metadata as a weak signal.
  const reviewerFiles = Object.values(context.prReviewMetadata?.changedFilesByReviewer ?? {}).flat();
  if (reviewerFiles.includes(filePath)) {
    return {
      confidence: "low",
      reason: "child-scope-match",
      filePath,
      commitSha,
    };
  }

  if (commitSha) {
    if (commitKnown) {
      return {
        confidence: "medium",
        reason: "commit-line-match",
        filePath,
        commitSha,
      };
    }
    return {
      confidence: "low",
      reason: "provider-uncertain",
      filePath,
      commitSha,
    };
  }

  if (isPreExistingFile(filePath, context)) {
    return {
      confidence: "low",
      reason: "pre-existing",
      filePath,
    };
  }

  return {
    confidence: "unattributed",
    reason: "unattributed",
    filePath,
  };
}

/**
 * Expose the ownership map built by the resolver. Useful for tests and for
 * callers that want to cache the map across many findings.
 */
export function buildChangedFileOwnership(context: QcAttributionContext): Record<string, string[]> {
  return collectChangedFilesByChild(context);
}

/**
 * Re-resolve attribution using a pre-built ownership map.
 */
export function resolveAttributionWithOwnership(
  finding: QcFinding,
  context: QcAttributionContext,
  ownership: Record<string, string[]>,
): QcAttribution {
  return resolveAttribution(finding, { ...context, changedFilesByChild: ownership });
}

/** Re-export context type under a shorter alias for callers. */
export type { ClusterState };
