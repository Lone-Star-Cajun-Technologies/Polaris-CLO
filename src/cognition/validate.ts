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
import { join, relative, resolve } from "node:path";
import { isCognitionSkippedFolder } from "./route-cognition-delta.js";
import { isSummaryOversized, hasDoctrineBled, SUMMARY_MAX_BYTES } from "./summary-delta.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CognitionViolationType =
  | "summary-oversized"
  | "summary-doctrine-bleed"
  | "polaris-churn-suspected"
  | "locality-violation";

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

/**
 * Validate all route-local cognition surfaces under repoRoot.
 *
 * Checks:
 * 1. SUMMARY.md size guard (≤ SUMMARY_MAX_BYTES)
 * 2. SUMMARY.md doctrine bleed
 * 3. Locality: POLARIS.md at root is not flagged (root is special)
 */
export function validateCognitionSurfaces(repoRoot: string): CognitionValidationResult {
  const violations: CognitionViolation[] = [];
  const warnings: CognitionViolation[] = [];

  for (const { rel, name } of walkForCognitionFiles(resolve(repoRoot), repoRoot)) {
    // Skip root-level files — root cognition is special (AGENTS.md / CLAUDE.md)
    if (!rel.includes("/")) continue;

    let content: string;
    try {
      content = readFileSync(resolve(repoRoot, rel), "utf-8");
    } catch {
      continue;
    }

    if (name === "SUMMARY.md") {
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
  const abs = existsSync(summaryPath) ? summaryPath : resolve(repoRoot, summaryPath);
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
