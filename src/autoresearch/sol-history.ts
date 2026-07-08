/**
 * SOL history store.
 *
 * Persists SolScoreReport snapshots as append-only JSONL under a
 * deterministic local artifact path. Each line is a self-contained
 * snapshot enriched with grouping keys from SolEvidence.
 *
 * Design rules:
 *   - Append-only: never rewrites or deletes historical entries.
 *   - Deterministic path: `.polaris/sol-history/scores.jsonl` relative to repo root.
 *   - Each snapshot includes run_id, cluster_id, scored_at, grouping_keys,
 *     and the full SolScoreReport for complete reproducibility.
 *   - No remote analytics — everything stays local.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SolScoreReport } from "../types/sol-score.js";
import type { SolGroupingKeys } from "../types/sol-evidence.js";

// ──────────────────────────────────────────────
// Snapshot type
// ──────────────────────────────────────────────

/**
 * A persisted SOL score snapshot with grouping metadata.
 */
export interface SolScoreSnapshot {
  /** Schema version for forward compatibility. */
  schema_version: "1.0";
  /** The full score report. */
  report: SolScoreReport;
  /** Grouping keys from the evidence used to produce this report. */
  grouping_keys: SolGroupingKeys;
  /** Worker IDs observed in the run. */
  worker_ids: string[];
}

// ──────────────────────────────────────────────
// Store path
// ──────────────────────────────────────────────

const DEFAULT_HISTORY_DIR = ".polaris/sol-history";
const SCORES_FILE = "scores.jsonl";

export function getHistoryDir(repoRoot: string, customPath?: string): string {
  return join(repoRoot, customPath ?? DEFAULT_HISTORY_DIR);
}

export function getHistoryFilePath(repoRoot: string, customPath?: string): string {
  return join(getHistoryDir(repoRoot, customPath), SCORES_FILE);
}

// ──────────────────────────────────────────────
// Write (append-only)
// ──────────────────────────────────────────────

/**
 * Persist a SOL score snapshot. Appends one JSONL line to the history file.
 * Creates the directory and file if they don't exist.
 *
 * @returns The path the snapshot was written to.
 */
export function appendSnapshot(
  repoRoot: string,
  snapshot: SolScoreSnapshot,
  customPath?: string,
): string {
  const dir = getHistoryDir(repoRoot, customPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const filePath = join(dir, SCORES_FILE);
  const line = JSON.stringify(snapshot) + "\n";
  appendFileSync(filePath, line, "utf-8");
  return filePath;
}

// ──────────────────────────────────────────────
// Read
// ──────────────────────────────────────────────

/**
 * Load all snapshots from the history file.
 * Returns an empty array when the file doesn't exist.
 */
export function loadSnapshots(repoRoot: string, customPath?: string): SolScoreSnapshot[] {
  const filePath = getHistoryFilePath(repoRoot, customPath);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const snapshots: SolScoreSnapshot[] = [];

  for (const line of lines) {
    try {
      snapshots.push(JSON.parse(line) as SolScoreSnapshot);
    } catch {
      // Skip malformed lines — append-only store tolerates partial writes
    }
  }
  return snapshots;
}

// ──────────────────────────────────────────────
// Build snapshot from report + evidence metadata
// ──────────────────────────────────────────────

/**
 * Build a SolScoreSnapshot from a report and evidence metadata.
 */
export function buildSnapshot(
  report: SolScoreReport,
  groupingKeys: SolGroupingKeys,
  workerIds: string[],
): SolScoreSnapshot {
  return {
    schema_version: "1.0",
    report,
    grouping_keys: groupingKeys,
    worker_ids: workerIds,
  };
}
