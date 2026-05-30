/**
 * SUMMARY.md delta logic.
 *
 * SUMMARY.md is the informational/contextual compression surface for a route.
 * It must stay short, remain informational only, and never become operational
 * doctrine or a giant architecture dump.
 *
 * Workers and ingest pipelines call applySummaryDelta() to determine whether
 * a SUMMARY.md update is warranted. Updates are delta-only: only spec/canon/
 * architecture/doctrine-linkage changes trigger a SUMMARY.md refresh.
 *
 * Root SUMMARY.md is skipped — route-local cognition begins below root.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isCognitionSkippedFolder } from "./route-cognition-delta.js";
import { parseFrontMatter } from "../smartdocs-engine/doctrine.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SummaryDeltaReason =
  | "linked-docs-changed"
  | "canon-relationships-changed"
  | "architecture-meaning-changed"
  | "doctrine-spec-linkage-changed";

/**
 * Precedence levels for SUMMARY.md generation source, highest to lowest:
 * 1. promoted-doctrine  — active doctrine files in smartdocs/doctrine/active/
 * 2. spec-or-arch       — linked specs or architecture docs (active or otherwise)
 * 3. route-polaris-md   — route-local POLARIS.md
 * 4. source-inference   — local source structure (fallback only)
 */
export type SummaryPrecedenceLevel =
  | "promoted-doctrine"
  | "spec-or-arch"
  | "route-polaris-md"
  | "source-inference";

export interface SummaryDeltaOptions {
  repoRoot: string;
  /** Files touched during this child's implementation or ingest. */
  touchedFiles: string[];
  /**
   * Skip updating root SUMMARY.md. Default: true.
   * Route-local cognition begins below root.
   */
  skipRoot?: boolean;
}

export interface SummaryDeltaResult {
  /** Whether a SUMMARY.md update is warranted. */
  updateWarranted: boolean;
  /** Reasons for the update (empty when not warranted). */
  reasons: SummaryDeltaReason[];
  /** Relative paths of nearest SUMMARY.md candidates found. */
  summaryTargets: string[];
  /** Folders missing SUMMARY.md that are eligible for one. */
  missingSummaries: string[];
  /**
   * Highest-precedence cognition source detected for the touched files.
   * Promoted doctrine overrides spec/arch, which overrides route POLARIS.md,
   * which overrides source-code inference (the fallback).
   */
  precedenceSource: SummaryPrecedenceLevel;
}

// ── Signals that trigger SUMMARY.md delta ─────────────────────────────────────

const SUMMARY_SIGNALS: Array<{ pattern: RegExp; reason: SummaryDeltaReason }> = [
  { pattern: /smartdocs\/docs\/specs\/raw\//,    reason: "linked-docs-changed" },
  { pattern: /smartdocs\/docs\/specs\/active\//, reason: "linked-docs-changed" },
  { pattern: /smartdocs\/docs\/doctrine\/active\//, reason: "doctrine-spec-linkage-changed" },
  { pattern: /smartdocs\/docs\/architecture\//, reason: "architecture-meaning-changed" },
  { pattern: /smartdocs\/docs\/decisions\//, reason: "doctrine-spec-linkage-changed" },
  { pattern: /\/canon\//,              reason: "canon-relationships-changed" },
  { pattern: /POLARIS\.md$/,           reason: "canon-relationships-changed" },
  { pattern: /AGENTS\.md$/,            reason: "canon-relationships-changed" },
  { pattern: /CLAUDE\.md$/,            reason: "canon-relationships-changed" },
  { pattern: /polaris\.config\.json$/, reason: "canon-relationships-changed" },
];

/**
 * Determine the highest-precedence cognition source for the given touched files.
 *
 * Priority (highest first):
 * 1. promoted-doctrine — active doctrine files in smartdocs/doctrine/active/
 * 2. spec-or-arch      — linked specs, architecture, or decision docs
 * 3. route-polaris-md  — a route-local POLARIS.md was touched
 * 4. source-inference  — no above signals; fallback
 */
export function detectPrecedenceLevel(
  touchedFiles: string[],
): SummaryPrecedenceLevel {
  for (const file of touchedFiles) {
    if (/smartdocs\/docs\/doctrine\/active\//.test(file)) return "promoted-doctrine";
  }
  for (const file of touchedFiles) {
    if (
      /smartdocs\/docs\/specs\/active\//.test(file) ||
      /smartdocs\/docs\/architecture\//.test(file) ||
      /smartdocs\/docs\/decisions\//.test(file) ||
      /smartdocs\/docs\/specs\/raw\//.test(file)
    ) return "spec-or-arch";
  }
  for (const file of touchedFiles) {
    if (/POLARIS\.md$/.test(file)) return "route-polaris-md";
  }
  return "source-inference";
}

/**
 * Detect which SUMMARY.md-relevant signals fire for the given touched files.
 */
export function detectSummaryReasons(
  touchedFiles: string[],
): SummaryDeltaReason[] {
  const reasonSet = new Set<SummaryDeltaReason>();
  for (const file of touchedFiles) {
    for (const signal of SUMMARY_SIGNALS) {
      if (signal.pattern.test(file)) {
        reasonSet.add(signal.reason);
      }
    }
  }
  return Array.from(reasonSet);
}

// ── source_paths enrichment ───────────────────────────────────────────────────

const SMARTDOC_SCAN_DIRS = [
  "smartdocs/doctrine/active",
  "smartdocs/specs/active",
];

/**
 * Scan active SmartDocs for `source_paths` frontmatter entries that overlap
 * with the touched files. Returns "linked-docs-changed" when any source path
 * of an active doc was touched, indicating the doc may be outdated.
 *
 * This enriches delta signals beyond file-path pattern matching by reading
 * the actual SmartDoc frontmatter at check time.
 */
export function detectSourcePathSignals(
  touchedFiles: string[],
  repoRoot: string,
): boolean {
  if (touchedFiles.length === 0) return false;
  const touchedSet = new Set(touchedFiles.map((f) => f.replace(/\\/g, "/")));

  for (const scanDir of SMARTDOC_SCAN_DIRS) {
    const absDir = join(repoRoot, scanDir);
    if (!existsSync(absDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const absFile = join(absDir, entry);
      let content: string;
      try {
        content = readFileSync(absFile, "utf-8");
      } catch {
        continue;
      }
      const fm = parseFrontMatter(content);
      const sourcePaths = fm["source_paths"];
      if (!sourcePaths) continue;
      const paths = sourcePaths
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      for (const sp of paths) {
        if (touchedSet.has(sp)) return true;
      }
    }
  }
  return false;
}

// ── Nearest route SUMMARY.md ──────────────────────────────────────────────────

/**
 * Find the nearest SUMMARY.md relative to a given file (below root).
 * Returns null when none found or only root exists.
 */
export function findNearestSummarymd(
  filePath: string,
  repoRoot: string,
  skipRoot: boolean,
): string | null {
  const parts = filePath.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const dir = parts.slice(0, i).join("/");
    if (isCognitionSkippedFolder(dir, repoRoot)) continue;
    const candidate = join(repoRoot, dir, "SUMMARY.md");
    if (existsSync(candidate)) {
      return relative(repoRoot, candidate).replace(/\\/g, "/");
    }
  }
  if (!skipRoot) {
    const rootCandidate = join(repoRoot, "SUMMARY.md");
    if (existsSync(rootCandidate)) return "SUMMARY.md";
  }
  return null;
}

// ── Missing SUMMARY.md detection ──────────────────────────────────────────────

/**
 * For each touched file, find folders that have a POLARIS.md but are missing a
 * SUMMARY.md. These are eligible for a SUMMARY.md draft.
 *
 * Informational only — callers should surface this as a hint, not pressure.
 * Workers must NOT create SUMMARY.md automatically from this result.
 */
export function detectMissingSummaries(
  touchedFiles: string[],
  repoRoot: string,
  skipRoot: boolean,
): string[] {
  const missing = new Set<string>();
  for (const file of touchedFiles) {
    const parts = file.split("/");
    for (let i = parts.length - 1; i >= 1; i--) {
      const dir = parts.slice(0, i).join("/");
      if (isCognitionSkippedFolder(dir, repoRoot)) continue;
      const hasPolarismd = existsSync(join(repoRoot, dir, "POLARIS.md"));
      const hasSummarymd = existsSync(join(repoRoot, dir, "SUMMARY.md"));
      if (hasPolarismd && !hasSummarymd) {
        missing.add(dir);
      }
      break;
    }
    if (!skipRoot) {
      const hasPolarismd = existsSync(join(repoRoot, "POLARIS.md"));
      const hasSummarymd = existsSync(join(repoRoot, "SUMMARY.md"));
      if (hasPolarismd && !hasSummarymd) {
        missing.add(".");
      }
    }
  }
  return Array.from(missing);
}

// ── Main delta entry point ────────────────────────────────────────────────────

/**
 * Determine whether a SUMMARY.md update is warranted for the given touched files.
 *
 * Does NOT write SUMMARY.md. Returns a result describing what was found so
 * the caller can conditionally instruct an update.
 */
export function applySummaryDelta(options: SummaryDeltaOptions): SummaryDeltaResult {
  const { repoRoot, touchedFiles, skipRoot = true } = options;

  const reasons = detectSummaryReasons(touchedFiles);

  // Enrich signals: if any touched file appears in source_paths of an active SmartDoc,
  // treat this as a linked-docs-changed signal even if path patterns didn't match.
  if (detectSourcePathSignals(touchedFiles, repoRoot)) {
    if (!reasons.includes("linked-docs-changed")) {
      reasons.push("linked-docs-changed");
    }
  }

  const updateWarranted = reasons.length > 0;
  const precedenceSource = detectPrecedenceLevel(touchedFiles);

  const summaryTargets = new Set<string>();
  for (const file of touchedFiles) {
    const target = findNearestSummarymd(file, repoRoot, skipRoot);
    if (target) summaryTargets.add(target);
  }

  const missingSummaries = detectMissingSummaries(touchedFiles, repoRoot, skipRoot);

  return {
    updateWarranted,
    reasons,
    summaryTargets: Array.from(summaryTargets),
    missingSummaries,
    precedenceSource,
  };
}

// ── SUMMARY.md content guard ──────────────────────────────────────────────────

export const SUMMARY_MAX_BYTES = 4096;

/**
 * Read SUMMARY.md content (relative to repoRoot). Returns null when missing.
 */
export function readSummarymd(summaryRel: string, repoRoot: string): string | null {
  const abs = resolve(repoRoot, summaryRel);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Returns true when a SUMMARY.md content string exceeds the size guard.
 */
export function isSummaryOversized(content: string): boolean {
  return Buffer.byteLength(content, "utf-8") > SUMMARY_MAX_BYTES;
}

/**
 * Returns true when a SUMMARY.md contains strong doctrine bleed patterns
 * (operational imperatives that belong in POLARIS.md).
 *
 * Deliberately narrow to avoid false-positives from quoted text or normal
 * prose that happens to contain "do not" or "never" in context.
 * This check is WARN-only — it must never be a hard blocker.
 */
export function hasDoctrineBled(content: string): boolean {
  const lower = content.toLowerCase();
  // Only flag unambiguous operational section headings and strong imperatives
  // that clearly belong in POLARIS.md rather than informational summaries.
  return (
    lower.includes("## editing rules") ||
    lower.includes("## constraints") ||
    lower.includes("## stop rule") ||
    lower.includes("## forbidden") ||
    // Strong imperative pattern: "must always" or "must never" at line start
    /^\s*[-*]?\s*\w[^.]*\bmust\s+(always|never)\b/m.test(lower)
  );
}
