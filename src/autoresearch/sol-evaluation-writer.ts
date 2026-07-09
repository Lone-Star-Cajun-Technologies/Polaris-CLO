/**
 * SOL evaluation artifact writer.
 *
 * Persists machine-readable SOL evaluation records and scorecard snapshots
 * to deterministic local paths. All writes are append-only / generation-safe:
 * existing source run evidence is never read or rewritten.
 *
 * Output locations:
 *   - Evaluations:   .polaris/sol/evaluations/<run-id>.json
 *   - Scorecards:    .polaris/sol/scorecards/<subject>/<scorecard-id>.json
 *   - Reports:       smartdocs/reports/sol/<run-id>-evaluation-report.md
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SolScoreReport } from "../types/sol-score.js";
import type { SolScorecard, SolScorecardSubject } from "../types/sol-scorecard.js";
import type { SolScorecardSet } from "./sol-scorecard-calculator.js";

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────

const EVALUATIONS_DIR = ".polaris/sol/evaluations";
const SCORECARDS_DIR = ".polaris/sol/scorecards";
const REPORTS_DIR = "smartdocs/reports/sol";

export function getSolEvaluationsDir(repoRoot: string): string {
  return join(repoRoot, EVALUATIONS_DIR);
}

export function getSolScorecardsDir(repoRoot: string): string {
  return join(repoRoot, SCORECARDS_DIR);
}

export function getSolReportsDir(repoRoot: string): string {
  return join(repoRoot, REPORTS_DIR);
}

// ──────────────────────────────────────────────
// Filename safety
// ──────────────────────────────────────────────

function safeFilename(value: string): string {
  // Prevent path traversal and reserved characters while keeping readability.
  return value
    .replace(/[\\/]+/g, "-")
    .replace(/[:\?*"<>|]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.]+/, "")
    .trim();
}

// ──────────────────────────────────────────────
// Evaluation record
// ──────────────────────────────────────────────

export interface SolEvaluationRecord {
  schema_version: "1.0";
  record_type: "sol-evaluation";
  run_id: string;
  cluster_id: string | null;
  scored_at: string;
  report: SolScoreReport;
  generated_at: string;
}

export function buildEvaluationRecord(report: SolScoreReport): SolEvaluationRecord {
  return {
    schema_version: "1.0",
    record_type: "sol-evaluation",
    run_id: report.run_id,
    cluster_id: report.cluster_id,
    scored_at: report.scored_at,
    report,
    generated_at: new Date().toISOString(),
  };
}

export function getEvaluationRecordPath(repoRoot: string, runId: string): string {
  return join(getSolEvaluationsDir(repoRoot), `${safeFilename(runId)}.json`);
}

/**
 * Write a SOL evaluation record under .polaris/sol/evaluations/.
 * Creates directories as needed. Overwrites only the derived record file.
 */
export function writeEvaluationRecord(
  repoRoot: string,
  report: SolScoreReport,
): { record: SolEvaluationRecord; path: string } {
  const record = buildEvaluationRecord(report);
  const dir = getSolEvaluationsDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = getEvaluationRecordPath(repoRoot, report.run_id);
  writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n", "utf-8");
  return { record, path: filePath };
}

// ──────────────────────────────────────────────
// Scorecard snapshots
// ──────────────────────────────────────────────

function scorecardSubjectDir(subject: SolScorecardSubject): string {
  return subject;
}

export function getScorecardPath(repoRoot: string, scorecard: SolScorecard): string {
  return join(
    getSolScorecardsDir(repoRoot),
    scorecardSubjectDir(scorecard.subject),
    `${safeFilename(scorecard.scorecard_id)}.json`,
  );
}

/**
 * Write a single scorecard snapshot under .polaris/sol/scorecards/<subject>/.
 */
export function writeScorecard(repoRoot: string, scorecard: SolScorecard): string {
  const dir = join(getSolScorecardsDir(repoRoot), scorecardSubjectDir(scorecard.subject));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = getScorecardPath(repoRoot, scorecard);
  writeFileSync(filePath, JSON.stringify(scorecard, null, 2) + "\n", "utf-8");
  return filePath;
}

/**
 * Write all scorecards in a SolScorecardSet. Returns the paths written.
 */
export function writeScorecardSet(repoRoot: string, scorecardSet: SolScorecardSet): string[] {
  const paths: string[] = [];
  paths.push(writeScorecard(repoRoot, scorecardSet.foreman));
  for (const s of scorecardSet.workers) paths.push(writeScorecard(repoRoot, s));
  for (const s of scorecardSet.providers) paths.push(writeScorecard(repoRoot, s));
  for (const s of scorecardSet.models) paths.push(writeScorecard(repoRoot, s));
  for (const s of scorecardSet.routing) paths.push(writeScorecard(repoRoot, s));
  return paths;
}

// ──────────────────────────────────────────────
// Human-readable SmartDocs report
// ──────────────────────────────────────────────

export function getSolMarkdownReportPath(repoRoot: string, runId: string): string {
  return join(getSolReportsDir(repoRoot), `${safeFilename(runId)}-evaluation-report.md`);
}

/**
 * Write a rendered Markdown SOL report to smartdocs/reports/sol/.
 */
export function writeSolMarkdownReport(
  repoRoot: string,
  runId: string,
  markdown: string,
): string {
  const dir = getSolReportsDir(repoRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = getSolMarkdownReportPath(repoRoot, runId);
  writeFileSync(filePath, markdown, "utf-8");
  return filePath;
}
