/**
 * SOL report generator.
 *
 * Groups historical SOL score snapshots by configurable dimensions and
 * produces summary reports in JSON or human-readable CLI format.
 *
 * Grouping dimensions: repo, route, task_type, role, risk, provider,
 * model, worker_id, run_id, and time window.
 */

import type { SolScoreSnapshot } from "./sol-history.js";
import type { SolGroupingKeys } from "../types/sol-evidence.js";

// ──────────────────────────────────────────────
// Grouping
// ──────────────────────────────────────────────

export type SolReportGroupBy =
  | "repo"
  | "route"
  | "task_type"
  | "role"
  | "risk"
  | "provider"
  | "model"
  | "worker_id"
  | "run_id"
  | "time_window";

export interface SolReportOptions {
  /** Dimensions to group by. Default: ["run_id"]. */
  groupBy?: SolReportGroupBy[];
  /** Time window size in days for "time_window" grouping. Default: 7. */
  windowDays?: number;
}

// ──────────────────────────────────────────────
// Group summary
// ──────────────────────────────────────────────

export interface SolGroupSummary {
  /** The group key label (e.g. "provider=devin" or "run_id=abc"). */
  group_key: string;
  /** Number of snapshots in this group. */
  count: number;
  /** Mean run composite score across snapshots (null when no scores). */
  mean_composite: number | null;
  /** Min run composite score. */
  min_composite: number | null;
  /** Max run composite score. */
  max_composite: number | null;
  /** Mean foreman composite score. */
  mean_foreman_composite: number | null;
  /** Mean worker composite score (averaged across all workers in all snapshots). */
  mean_worker_composite: number | null;
  /** Earliest scored_at in this group. */
  earliest: string | null;
  /** Latest scored_at in this group. */
  latest: string | null;
}

export interface SolReport {
  /** Total snapshots analyzed. */
  total_snapshots: number;
  /** Grouping dimensions used. */
  grouped_by: SolReportGroupBy[];
  /** Group summaries. */
  groups: SolGroupSummary[];
  /** Overall mean composite across all snapshots. */
  overall_mean_composite: number | null;
  /** Generated at timestamp. */
  generated_at: string;
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function getGroupKey(
  snapshot: SolScoreSnapshot,
  dimension: SolReportGroupBy,
  windowDays: number,
): string {
  const keys: SolGroupingKeys = snapshot.grouping_keys;
  switch (dimension) {
    case "repo": return keys.repo ?? "unknown";
    case "route": return keys.route ?? "unknown";
    case "task_type": return keys.task_type ?? "unknown";
    case "role": return keys.role ?? "unknown";
    case "risk": return keys.risk ?? "unknown";
    case "provider": return keys.provider ?? "unknown";
    case "model": return keys.model ?? "unknown";
    case "worker_id":
      return snapshot.worker_ids.length > 0 ? snapshot.worker_ids.join(",") : "unknown";
    case "run_id": return snapshot.report.run_id;
    case "time_window": {
      const d = new Date(snapshot.report.scored_at);
      if (isNaN(d.getTime())) return "unknown";
      // Bucket by windowDays from epoch
      const daysSinceEpoch = Math.floor(d.getTime() / (86400000 * windowDays));
      const bucketStart = new Date(daysSinceEpoch * 86400000 * windowDays);
      return bucketStart.toISOString().slice(0, 10);
    }
  }
}

function compositeGroupKey(
  snapshot: SolScoreSnapshot,
  dimensions: SolReportGroupBy[],
  windowDays: number,
): string {
  return dimensions.map((d) => `${d}=${getGroupKey(snapshot, d, windowDays)}`).join("|");
}

function meanOrNull(nums: (number | null)[]): number | null {
  const valid = nums.filter((n): n is number => n !== null);
  if (valid.length === 0) return null;
  return Number((valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(4));
}

function minOrNull(nums: (number | null)[]): number | null {
  const valid = nums.filter((n): n is number => n !== null);
  return valid.length > 0 ? Math.min(...valid) : null;
}

function maxOrNull(nums: (number | null)[]): number | null {
  const valid = nums.filter((n): n is number => n !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

// ──────────────────────────────────────────────
// Report generation
// ──────────────────────────────────────────────

export function generateReport(
  snapshots: SolScoreSnapshot[],
  options: SolReportOptions = {},
): SolReport {
  const groupBy = options.groupBy ?? ["run_id"];
  const windowDays = options.windowDays ?? 7;

  // Group snapshots
  const groups = new Map<string, SolScoreSnapshot[]>();
  for (const s of snapshots) {
    const key = compositeGroupKey(s, groupBy, windowDays);
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }

  // Build summaries
  const summaries: SolGroupSummary[] = [];
  for (const [key, snaps] of groups) {
    const composites = snaps.map((s) => s.report.run_composite_score);
    const foremanComposites = snaps.map((s) => s.report.foreman.composite_score);

    // Flatten all worker composites across snapshots
    const workerComposites: (number | null)[] = [];
    for (const s of snaps) {
      for (const w of Object.values(s.report.workers)) {
        workerComposites.push(w.composite_score);
      }
    }

    const scoredAts = snaps
      .map((s) => s.report.scored_at)
      .filter((t) => t)
      .sort();

    summaries.push({
      group_key: key,
      count: snaps.length,
      mean_composite: meanOrNull(composites),
      min_composite: minOrNull(composites),
      max_composite: maxOrNull(composites),
      mean_foreman_composite: meanOrNull(foremanComposites),
      mean_worker_composite: meanOrNull(workerComposites),
      earliest: scoredAts[0] ?? null,
      latest: scoredAts[scoredAts.length - 1] ?? null,
    });
  }

  // Sort groups by key for deterministic output
  summaries.sort((a, b) => a.group_key.localeCompare(b.group_key));

  const allComposites = snapshots.map((s) => s.report.run_composite_score);

  return {
    total_snapshots: snapshots.length,
    grouped_by: groupBy,
    groups: summaries,
    overall_mean_composite: meanOrNull(allComposites),
    generated_at: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────
// Human-readable formatter
// ──────────────────────────────────────────────

function fmtScore(v: number | null): string {
  return v !== null ? v.toFixed(4) : "N/A";
}

export function formatReportCli(report: SolReport): string {
  const lines: string[] = [];
  lines.push(`SOL History Report`);
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Total snapshots: ${report.total_snapshots}`);
  lines.push(`Grouped by: ${report.grouped_by.join(", ")}`);
  lines.push(`Overall mean composite: ${fmtScore(report.overall_mean_composite)}`);
  lines.push("");

  if (report.groups.length === 0) {
    lines.push("No data.");
    return lines.join("\n");
  }

  // Table header
  lines.push(
    padRight("Group", 40) +
    padRight("Count", 7) +
    padRight("Mean", 8) +
    padRight("Min", 8) +
    padRight("Max", 8) +
    padRight("Foreman", 9) +
    "Worker",
  );
  lines.push("-".repeat(88));

  for (const g of report.groups) {
    lines.push(
      padRight(g.group_key.slice(0, 39), 40) +
      padRight(String(g.count), 7) +
      padRight(fmtScore(g.mean_composite), 8) +
      padRight(fmtScore(g.min_composite), 8) +
      padRight(fmtScore(g.max_composite), 8) +
      padRight(fmtScore(g.mean_foreman_composite), 9) +
      fmtScore(g.mean_worker_composite),
    );
  }

  return lines.join("\n") + "\n";
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
