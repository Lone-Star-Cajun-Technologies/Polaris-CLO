/**
 * Cognition surface validation.
 *
 * Validates SUMMARY.md and POLARIS.md files for:
 * - Oversized SUMMARY.md (exceeds byte cap)
 * - Doctrine bleed in SUMMARY.md (operational imperatives belong in POLARIS.md)
 * - POLARIS.md churn detection (trivial/non-operational changes)
 * - Locality assumptions (route-local only, no repo-wide surface)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { isCognitionSkippedFolder } from "./route-cognition-delta.js";
import { isSummaryOversized, hasDoctrineBled, SUMMARY_MAX_BYTES } from "./summary-delta.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CognitionViolationType =
  | "summary-oversized"
  | "summary-doctrine-bleed"
  | "polaris-churn-suspected"
  | "locality-violation"
  | "polaris-summary-drift";

export interface CognitionValidationOptions {
  /** Normalized similarity threshold above which sibling drift is warned. */
  similarityThreshold?: number;
}

const DEFAULT_PAIRWISE_DRIFT_THRESHOLD = 0.5;

// ── Pairwise POLARIS.md / SUMMARY.md drift detection ───────────────────────────

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize route artifact text so shared boilerplate (headings, links, route
 * names) does not dominate similarity scores.
 */
function normalizeRouteArtifact(content: string, routeName?: string): string {
  let s = content.toLowerCase();
  // Strip markdown headings
  s = s.replace(/^#+\s+.*$/gm, " ");
  // Remove link URLs but keep link text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Remove bare URLs
  s = s.replace(/https?:\/\/\S+/g, " ");
  // Remove route name tokens
  if (routeName) {
    for (const token of routeName.split(/[-_\s]+/).filter(Boolean)) {
      s = s.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"), " ");
    }
  }
  // Drop non-alphanumeric characters
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Compute a normalized Jaccard similarity between two route artifacts.
 * Returns a value between 0 and 1.
 */
export function computeNormalizedSimilarity(
  a: string,
  b: string,
  routeName?: string,
): number {
  const tokensA = new Set(normalizeRouteArtifact(a, routeName).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeRouteArtifact(b, routeName).split(" ").filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

export interface CognitionViolation {
  type: CognitionViolationType;
  file: string;
  detail: string;
  /**
   * "error" violations affect valid:false.
   * "warn" violations are surfaced but do not fail validation.
   * summary-doctrine-bleed is always "warn" to avoid false-positives from
   * quoted text or normal prose.
   */
  severity: "error" | "warn";
}

export interface CognitionValidationResult {
  valid: boolean;
  /** Hard violations (severity: error). */
  violations: CognitionViolation[];
  /** Advisory warnings (severity: warn). */
  warnings: CognitionViolation[];
}

// ── POLARIS.md churn detection ────────────────────────────────────────────────

/**
 * Signals that indicate a POLARIS.md change is likely non-operational churn
 * (formatting, comments, tiny refactors).
 * Returns true when the diff looks like churn.
 */
export function looksLikePolarisChurn(before: string, after: string): boolean {
  // Normalize whitespace and comments for comparison
  const normalize = (s: string) =>
    s
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => !l.startsWith("<!--") && l !== "")
      .join("\n");
  const a = normalize(before);
  const b = normalize(after);
  // If normalized content is identical, it's churn
  if (a === b) return true;
  // If only whitespace/blank-line diff
  if (before.replace(/\s+/g, " ").trim() === after.replace(/\s+/g, " ").trim()) return true;
  return false;
}

// ── Walker ────────────────────────────────────────────────────────────────────

function* walkForCognitionFiles(
  dir: string,
  repoRoot: string,
): Generator<{ rel: string; name: string }> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(repoRoot, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (isCognitionSkippedFolder(rel + "/") || isCognitionSkippedFolder(rel)) continue;
      yield* walkForCognitionFiles(full, repoRoot);
    } else if (entry.name === "SUMMARY.md" || entry.name === "POLARIS.md") {
      yield { rel, name: entry.name };
    }
  }
}

// ── Main validation entry point ───────────────────────────────────────────────

interface RouteArtifactPair {
  dirRel: string;
  polarisRel?: string;
  summaryRel?: string;
  polaris?: string;
  summary?: string;
}

/**
 * Validate all route-local cognition surfaces under repoRoot.
 *
 * Checks:
 * 1. SUMMARY.md size guard (≤ SUMMARY_MAX_BYTES)
 * 2. SUMMARY.md doctrine bleed
 * 3. Pairwise POLARIS.md / SUMMARY.md drift (exact duplicate → error,
 *    high normalized similarity → warn)
 * 4. Locality: POLARIS.md at root is not flagged (root is special)
 */
export function validateCognitionSurfaces(
  repoRoot: string,
  options: CognitionValidationOptions = {},
): CognitionValidationResult {
  const violations: CognitionViolation[] = [];
  const warnings: CognitionViolation[] = [];
  const threshold = options.similarityThreshold ?? DEFAULT_PAIRWISE_DRIFT_THRESHOLD;
  const pairs = new Map<string, RouteArtifactPair>();

  for (const { rel, name } of walkForCognitionFiles(resolve(repoRoot), repoRoot)) {
    // Skip root-level files — root cognition is special (AGENTS.md / CLAUDE.md)
    if (!rel.includes("/")) continue;

    let content: string;
    try {
      content = readFileSync(resolve(repoRoot, rel), "utf-8");
    } catch {
      continue;
    }

    const absDir = dirname(resolve(repoRoot, rel));
    const dirRel = relative(repoRoot, absDir).replace(/\\/g, "/");
    let entry = pairs.get(absDir);
    if (!entry) {
      entry = { dirRel };
      pairs.set(absDir, entry);
    }

    if (name === "SUMMARY.md") {
      entry.summary = content;
      entry.summaryRel = rel;
      if (isSummaryOversized(content)) {
        const bytes = Buffer.byteLength(content, "utf-8");
        violations.push({
          type: "summary-oversized",
          file: rel,
          detail: `SUMMARY.md is ${bytes} bytes, exceeds limit of ${SUMMARY_MAX_BYTES} bytes`,
          severity: "error",
        });
      }
      if (hasDoctrineBled(content)) {
        // Doctrine bleed is WARN-only — never a hard blocker.
        // Summaries may contain "do not" in quoted context.
        warnings.push({
          type: "summary-doctrine-bleed",
          file: rel,
          detail: "SUMMARY.md may contain operational doctrine (section headings or imperatives); consider moving to POLARIS.md",
          severity: "warn",
        });
      }
    } else if (name === "POLARIS.md") {
      entry.polaris = content;
      entry.polarisRel = rel;
    }
  }

  for (const entry of pairs.values()) {
    if (!entry.polaris || !entry.summary || !entry.polarisRel || !entry.summaryRel) continue;

    if (entry.polaris === entry.summary) {
      violations.push({
        type: "polaris-summary-drift",
        file: entry.dirRel,
        detail: `Route ${entry.dirRel}: POLARIS.md and SUMMARY.md are exact duplicates (${entry.polarisRel}, ${entry.summaryRel})`,
        severity: "error",
      });
      continue;
    }

    const routeName = entry.dirRel === "." ? undefined : basename(entry.dirRel);
    const similarity = computeNormalizedSimilarity(entry.polaris, entry.summary, routeName);
    if (similarity >= threshold) {
      warnings.push({
        type: "polaris-summary-drift",
        file: entry.dirRel,
        detail: `Route ${entry.dirRel}: POLARIS.md and SUMMARY.md normalized similarity ${similarity.toFixed(2)} exceeds threshold ${threshold} (${entry.polarisRel}, ${entry.summaryRel})`,
        severity: "warn",
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    warnings,
  };
}

// ── Targeted file validation ──────────────────────────────────────────────────

/**
 * Validate a single SUMMARY.md file by path (absolute or relative to repoRoot).
 */
export function validateSummaryFile(
  summaryPath: string,
  repoRoot: string,
): CognitionViolation[] {
  const abs = summaryPath.startsWith("/") ? summaryPath : resolve(repoRoot, summaryPath);
  const rel = relative(repoRoot, abs).replace(/\\/g, "/");
  const results: CognitionViolation[] = [];

  let content: string;
  try {
    content = readFileSync(abs, "utf-8");
  } catch {
    return results;
  }

  if (isSummaryOversized(content)) {
    const bytes = Buffer.byteLength(content, "utf-8");
    results.push({
      type: "summary-oversized",
      file: rel,
      detail: `SUMMARY.md is ${bytes} bytes, exceeds limit of ${SUMMARY_MAX_BYTES} bytes`,
      severity: "error",
    });
  }
  if (hasDoctrineBled(content)) {
    // Warn-only — see hasDoctrineBled() docstring.
    results.push({
      type: "summary-doctrine-bleed",
      file: rel,
      detail: "SUMMARY.md may contain operational doctrine; consider moving to POLARIS.md",
      severity: "warn",
    });
  }

  return results;
}

/**
 * Check file size on disk for a SUMMARY.md without reading full content.
 */
export function getSummaryFileSize(summaryPath: string, repoRoot: string): number {
  const abs = existsSync(summaryPath) ? summaryPath : resolve(repoRoot, summaryPath);
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}
