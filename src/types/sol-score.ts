/**
 * SOL scoring model types.
 *
 * Defines the typed output of the SOL score reports for Foremen and Workers.
 * Each dimension has a score, confidence, and optional skipped reason so that
 * callers can preserve the full diagnostic signal rather than a single opaque
 * number.
 *
 * Design rules:
 *   - score is 0.0–1.0 where 1.0 = optimal and 0.0 = worst observed behavior.
 *   - confidence reflects how trustworthy the score is given the evidence.
 *   - skipped_reason is set when evidence was absent or insufficient.
 *   - All dimensions are optional at the top level; only present when the
 *     relevant evidence was observed for this run.
 *   - The existing binary gate diagnosis is preserved alongside SOL scores.
 */

// ──────────────────────────────────────────────
// Confidence tiers
// ──────────────────────────────────────────────

/**
 * Confidence in a scored dimension.
 *
 * - "high"   : Multiple evidence signals available; score is reliable.
 * - "medium" : Single evidence signal or partial data; score is indicative.
 * - "low"    : Minimal data; treat with caution.
 * - "none"   : No evidence; dimension was skipped.
 */
export type SolScoreConfidence = "high" | "medium" | "low" | "none";

// ──────────────────────────────────────────────
// Dimension score
// ──────────────────────────────────────────────

/**
 * A single scored dimension in a SOL score report.
 */
export interface SolDimensionScore {
  /** Dimension label, e.g. "token", "duration", "validation". */
  dimension: string;
  /**
   * Normalized score 0.0–1.0.
   * Present when confidence > "none".
   * Null when the dimension was skipped.
   */
  score: number | null;
  /** Confidence in this dimension's score. */
  confidence: SolScoreConfidence;
  /** Human-readable explanation when score is null (dimension was skipped). */
  skipped_reason?: string;
  /** Optional supporting detail for this score (e.g. observed token count). */
  detail?: string;
}

// ──────────────────────────────────────────────
// Foreman score report
// ──────────────────────────────────────────────

/**
 * SOL score report for the Foreman role.
 *
 * Dimensions sourced from POL-462 Foreman scoring requirements:
 *   token usage, runtime duration, intervention frequency, pre-analysis,
 *   dependency handling, dispatch accuracy, evidence validation, scope
 *   control, completion, and failure recovery.
 */
export interface SolForemanScoreReport {
  /** Total composite score (mean of non-null dimension scores). */
  composite_score: number | null;
  /** Confidence of the composite score. */
  composite_confidence: SolScoreConfidence;
  /** Token usage — measures bootstrap context efficiency. */
  token: SolDimensionScore;
  /** Runtime duration — proxy: dispatch epoch / re-dispatch overhead. */
  duration: SolDimensionScore;
  /** Intervention frequency — user and foreman corrective commits. */
  intervention: SolDimensionScore;
  /** Pre-analysis quality — escalation events as a proxy for pre-analysis gaps. */
  pre_analysis: SolDimensionScore;
  /** Dependency handling — whether dependent children were dispatched correctly. */
  dependency: SolDimensionScore;
  /** Dispatch accuracy — re-dispatch rate for the same child. */
  dispatch: SolDimensionScore;
  /** Evidence validation — heartbeat coverage and completion signals. */
  evidence_validation: SolDimensionScore;
  /** Scope control — out-of-scope escalation events. */
  scope: SolDimensionScore;
  /** Completion — fraction of children that completed successfully. */
  completion: SolDimensionScore;
  /** Failure recovery — state repair detection. */
  recovery: SolDimensionScore;
}

// ──────────────────────────────────────────────
// Worker score report
// ──────────────────────────────────────────────

/**
 * SOL score report for one Worker child.
 *
 * Dimensions sourced from POL-462 Worker scoring requirements:
 *   token usage, runtime duration, validation, QC findings, repair
 *   iterations, scope adherence, acceptance criteria, and first-pass success.
 */
export interface SolWorkerScoreReport {
  /** The child being scored. */
  child_id: string;
  /** Total composite score (mean of non-null dimension scores). */
  composite_score: number | null;
  /** Confidence of the composite score. */
  composite_confidence: SolScoreConfidence;
  /** Token usage efficiency for this worker. */
  token: SolDimensionScore;
  /** Runtime duration proxy: heartbeat count as activity signal. */
  duration: SolDimensionScore;
  /** Validation outcome: passed/failed. */
  validation: SolDimensionScore;
  /** QC findings attributed to this child (weighted score). */
  qc: SolDimensionScore;
  /** Repair iterations: escalation count proxy for re-work. */
  repair_iterations: SolDimensionScore;
  /** Scope adherence: whether out-of-scope blocks were raised. */
  scope_adherence: SolDimensionScore;
  /** Acceptance criteria: validation commands completed successfully. */
  acceptance_criteria: SolDimensionScore;
  /** First-pass success: did the worker succeed without foreman/user intervention? */
  first_pass: SolDimensionScore;
}

// ──────────────────────────────────────────────
// Combined SOL score report (run-level)
// ──────────────────────────────────────────────

/**
 * Full SOL score report for a run.
 * Wraps both the Foreman and per-worker scores alongside the existing
 * binary gate diagnosis for compatibility.
 */
export interface SolScoreReport {
  run_id: string;
  cluster_id: string | null;
  scored_at: string;
  /** Foreman-level score. */
  foreman: SolForemanScoreReport;
  /** Per-worker scores keyed by child_id. */
  workers: Record<string, SolWorkerScoreReport>;
  /**
   * Overall run composite: mean of foreman composite and all worker composites.
   * Null when no scoreable dimensions are available.
   */
  run_composite_score: number | null;
}
