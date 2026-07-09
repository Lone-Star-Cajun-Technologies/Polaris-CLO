/**
 * SOL scorecard schema.
 *
 * Defines durable, reproducible scorecards for SOL evaluation subjects
 * (Foreman, workers, providers, models, routing decisions, token efficiency,
 * QC outcomes, and user/Foreman intervention). Scorecards are distinct from
 * the run-level SolScoreReport: they are per-scope, carry explicit formula
 * versions, source references, and recommendation inputs.
 *
 * Architecture reference: sol-evaluation-report-architecture.md §Artifact classes
 *
 * Design rules:
 *   - Every scorecard carries a formula_version so consumers can detect drift.
 *   - source_refs link back to the immutable raw evidence that produced the scorecard.
 *   - Missing evidence results in SolScorecardAvailability="skipped" with reasons.
 *   - Scorecards are derived and reproducible; raw evidence always wins on conflict.
 *   - Existing SolScoreReport (run-level evaluation) remains unchanged.
 */

import type { SolGroupingKeys } from "./sol-evidence.js";
import type { SolScoreConfidence } from "./sol-score.js";

// ──────────────────────────────────────────────
// Formula versioning
// ──────────────────────────────────────────────

/**
 * Versioned formula identifier.
 *
 * Format: "<formula-name>/<semver>"
 * Example: "token-efficiency/1.0", "quality-per-token/1.0"
 *
 * Consumers must reject or re-score a scorecard when the formula version
 * differs from their expected version.
 */
export type SolFormulaVersion = string;

/**
 * Token efficiency formula specification (version 1.0).
 *
 * Measures how efficiently a subject uses its token budget.
 *
 * Foreman formula (v1.0):
 *   score = 1.0                                  when tokens ≤ BUDGET
 *   score = 1.0 - (tokens - BUDGET) / RANGE      when BUDGET < tokens < BUDGET + RANGE
 *   score = 0.0                                  when tokens ≥ BUDGET + RANGE
 *
 *   where BUDGET = 150_000, RANGE = 150_000 (max = 300_000)
 *
 * Worker formula (v1.0):
 *   score = 1.0                                  when tokens ≤ BUDGET
 *   score = 1.0 - (tokens - BUDGET) / RANGE      when BUDGET < tokens < BUDGET + RANGE
 *   score = 0.0                                  when tokens ≥ BUDGET + RANGE
 *
 *   where BUDGET = 200_000, RANGE = 300_000 (max = 500_000)
 */
export interface SolTokenEfficiencyFormulaSpec {
  formula_version: "token-efficiency/1.0";
  /** Token budget threshold below which score = 1.0. */
  budget: number;
  /** Token count at which score = 0.0 (budget + range). */
  max_penalized: number;
  /** Source: "bootstrap-context-size" events (Foreman) or "worker-heartbeat" tokens_used (Worker). */
  source_event_type: "bootstrap-context-size" | "worker-heartbeat-tokens";
}

/**
 * Quality-per-token formula specification (version 1.0).
 *
 * Relates output quality (composite score) to token cost.
 * Used for cross-run comparison of efficiency.
 *
 * Formula (v1.0):
 *   quality_per_token = composite_score / normalized_token_cost
 *
 *   where normalized_token_cost = tokens_used / budget
 *   and composite_score is the run or worker composite (0.0–1.0).
 *
 * Skipped when tokens_used is unavailable or composite_score is null.
 */
export interface SolQualityPerTokenFormulaSpec {
  formula_version: "quality-per-token/1.0";
  /** Token budget normalization denominator. */
  budget_denominator: number;
  /** Subject: "foreman" for run-level, "worker" for per-child. */
  subject: "foreman" | "worker";
}

// ──────────────────────────────────────────────
// Scorecard subject and window
// ──────────────────────────────────────────────

/**
 * The type of subject a scorecard evaluates.
 */
export type SolScorecardSubject =
  | "foreman"
  | "worker"
  | "provider"
  | "model"
  | "routing"
  | "token-efficiency"
  | "qc-outcome"
  | "intervention";

/**
 * The observation window a scorecard covers.
 *
 * For run-scoped scorecards: run_id and cluster_id are set.
 * For aggregate scorecards: time_window, route, or task_type may be set instead.
 */
export interface SolScorecardWindow {
  /** Run identifier, when this scorecard is scoped to a single run. */
  run_id?: string;
  /** Cluster identifier, when scoped to a cluster. */
  cluster_id?: string;
  /** ISO 8601 start of the time window. */
  window_start?: string;
  /** ISO 8601 end of the time window. */
  window_end?: string;
  /** Number of runs / snapshots covered by this window. */
  sample_count?: number;
}

// ──────────────────────────────────────────────
// Raw metrics (immutable evidence snapshot)
// ──────────────────────────────────────────────

/**
 * Raw metric snapshot captured at scorecard generation time.
 *
 * These are read-only copies of the evidence values that produced each
 * subscore. Preserving them allows exact reproduction of the scorecard
 * without re-reading artifact files.
 *
 * Not all fields are populated for every subject type; absent fields are null.
 */
export interface SolScorecardRawMetrics {
  // ── Token metrics ──
  /** Max combined bootstrap context tokens (Foreman). */
  max_bootstrap_tokens: number | null;
  /** Per-child token usage (Worker). */
  worker_tokens_used: number | null;

  // ── Runtime / dispatch ──
  /** Dispatch epoch from run state. */
  dispatch_epoch: number | null;
  /** Continue epoch from run state. */
  continue_epoch: number | null;
  /** Total children in the run. */
  total_children: number | null;
  /** Count of children that completed with status "done". */
  workers_succeeded: number | null;
  /** Count of workers that failed. */
  workers_failed: number | null;
  /** Count of re-dispatched children. */
  redispatch_count: number | null;

  // ── Validation ──
  /** Raw validation outcome for this subject ("passed"|"failed"|"skipped"|"unknown"). */
  validation_outcome: string | null;
  /** Validation commands that passed. */
  passed_commands: string[];

  // ── QC ──
  /** Total QC findings. */
  qc_total_findings: number | null;
  /** Blocking QC findings. */
  qc_blocking_findings: number | null;
  /** Repaired QC findings. */
  qc_repaired_findings: number | null;
  /** QC repair loop status. */
  qc_repair_loop_status: string | null;
  /** QC repair loop rounds completed / max. */
  qc_repair_rounds: { completed: number; max: number } | null;

  // ── Escalation / intervention ──
  /** Escalation count for this subject. */
  escalation_count: number | null;
  /** Count of out-of-scope escalation events. */
  out_of_scope_count: number | null;
  /** Whether user intervention was detected. */
  user_intervened: boolean | null;
  /** Whether Foreman intervention was detected. */
  foreman_intervened: boolean | null;
  /** Whether state-repair artifacts were detected. */
  state_repair_required: boolean | null;

  // ── Router ──
  /** Provider selection outcome for this subject. */
  provider_selected: string | null;
  /** Whether a fallback provider was used. */
  router_fallback_used: boolean | null;
  /** Whether the router exhausted all providers. */
  router_exhausted: boolean | null;
  /** Router exhaustion reason. */
  router_exhausted_reason: string | null;

  // ── Heartbeats ──
  /** Heartbeat count for this subject. */
  heartbeat_count: number | null;
}

// ──────────────────────────────────────────────
// Subscores
// ──────────────────────────────────────────────

/**
 * A single subscore within a scorecard.
 * Mirrors SolDimensionScore but explicitly carries a formula version.
 */
export interface SolSubscore {
  /** Subscore label (e.g. "token", "validation", "qc_repair_loop"). */
  dimension: string;
  /** Versioned formula used to compute this subscore. */
  formula_version: SolFormulaVersion;
  /** Normalized score 0.0–1.0. Null when the dimension was skipped. */
  score: number | null;
  /** Confidence in this subscore. */
  confidence: SolScoreConfidence;
  /** Human-readable reason when score is null. */
  skipped_reason?: string;
  /** Supporting detail from the raw metric (e.g. "tokens_used=120000"). */
  detail?: string;
}

// ──────────────────────────────────────────────
// Source references
// ──────────────────────────────────────────────

/**
 * Artifact reference: names a specific durable file that contributed evidence.
 */
export interface SolSourceRef {
  /** Artifact kind (e.g. "run-state", "telemetry", "result-packet", "qc-finding", "cluster-state"). */
  kind: string;
  /**
   * Repo-relative path to the artifact.
   * Example: ".taskchain_artifacts/polaris-run/current-state.json"
   */
  path: string;
  /** Whether this artifact was present at scorecard generation time. */
  available: boolean;
  /** Human-readable explanation when available=false. */
  unavailable_reason?: string;
}

// ──────────────────────────────────────────────
// Recommendation inputs
// ──────────────────────────────────────────────

/**
 * Derived facts that may feed Worker Router advice or recommendations.
 *
 * Recommendation inputs are advisory only. They are computed from scorecard
 * evidence and must not be applied automatically.
 */
export interface SolRecommendationInputs {
  /** Whether this subject's composite score is below the alert threshold (0.6). */
  below_threshold: boolean;
  /** Dimensions with score < 0.5 (potential focus areas). */
  low_scoring_dimensions: string[];
  /** Dimensions skipped due to missing evidence. */
  skipped_dimensions: string[];
  /** Whether token efficiency formula triggered an over-budget condition. */
  over_token_budget: boolean;
  /** Whether user or Foreman intervention was detected. */
  intervention_detected: boolean;
  /** Whether router exhaustion or fallback was observed. */
  router_issue_detected: boolean;
  /** Whether QC findings blocked delivery or repair failed. */
  qc_issue_detected: boolean;
  /** Free-form notes for downstream recommendation generation. */
  notes: string[];
}

// ──────────────────────────────────────────────
// Scorecard availability
// ──────────────────────────────────────────────

/**
 * Whether a scorecard could be fully produced.
 *
 * - "complete"   : All required evidence was present; all subscores are scored.
 * - "partial"    : Some evidence was missing; some subscores are skipped.
 * - "skipped"    : Critical evidence was absent; scorecard is advisory only.
 * - "unavailable": No evidence could be loaded; scorecard body is empty.
 */
export type SolScorecardAvailability = "complete" | "partial" | "skipped" | "unavailable";

// ──────────────────────────────────────────────
// Core scorecard type
// ──────────────────────────────────────────────

/**
 * A durable, per-scope SOL scorecard.
 *
 * A Scorecard differs from SolScoreReport (run-level evaluation) in that:
 *   - It is scoped to a single subject (Foreman, worker, provider, model, etc.).
 *   - It carries an explicit formula_version for every subscore.
 *   - It preserves raw_metrics for exact reproducibility.
 *   - It carries source_refs that name every artifact used.
 *   - It carries recommendation_inputs for downstream advisory use.
 *
 * Scorecard files are stored at:
 *   .polaris/sol/scorecards/<subject>/<key>.json
 */
export interface SolScorecard {
  /** Schema version for forward compatibility. */
  schema_version: "1.0";
  /** Unique scorecard identifier (e.g. "foreman-<run-id>" or "worker-<child-id>-<run-id>"). */
  scorecard_id: string;
  /** Type of subject this scorecard evaluates. */
  subject: SolScorecardSubject;
  /** Subject-specific key (e.g. child_id for workers, provider name for providers). */
  subject_key: string;
  /** Observation window this scorecard covers. */
  window: SolScorecardWindow;
  /** Grouping keys for trend aggregation. */
  grouping_keys: SolGroupingKeys;
  /** ISO 8601 timestamp when the scorecard was generated. */
  generated_at: string;
  /** Whether the scorecard is complete, partial, skipped, or unavailable. */
  availability: SolScorecardAvailability;
  /** Reason when availability is "skipped" or "unavailable". */
  availability_reason?: string;
  /** Raw metrics snapshot that produced these subscores. */
  raw_metrics: SolScorecardRawMetrics;
  /** Per-dimension subscores with formula versions. */
  subscores: SolSubscore[];
  /**
   * Aggregate score (weighted mean of non-null subscores).
   * Null when availability is "unavailable" or all subscores are skipped.
   */
  aggregate_score: number | null;
  /** Confidence in the aggregate score. */
  aggregate_confidence: SolScoreConfidence;
  /** Artifact references that contributed evidence. */
  source_refs: SolSourceRef[];
  /** Derived inputs for advisory recommendations. */
  recommendation_inputs: SolRecommendationInputs;
  /**
   * Formula version applied to the aggregate score.
   * Currently: "composite-mean/1.0" (simple mean of non-null subscores).
   */
  aggregate_formula_version: SolFormulaVersion;
}

// ──────────────────────────────────────────────
// Helpers: formula version constants
// ──────────────────────────────────────────────

/**
 * Named formula version constants.
 * Use these in subscore and aggregate formula_version fields.
 */
export const SOL_FORMULA_VERSIONS = {
  TOKEN_EFFICIENCY_V1: "token-efficiency/1.0" as SolFormulaVersion,
  QUALITY_PER_TOKEN_V1: "quality-per-token/1.0" as SolFormulaVersion,
  COMPOSITE_MEAN_V1: "composite-mean/1.0" as SolFormulaVersion,
  VALIDATION_BINARY_V1: "validation-binary/1.0" as SolFormulaVersion,
  DISPATCH_RATE_V1: "dispatch-rate/1.0" as SolFormulaVersion,
  INTERVENTION_BINARY_V1: "intervention-binary/1.0" as SolFormulaVersion,
  QC_REPAIR_LOOP_V1: "qc-repair-loop/1.0" as SolFormulaVersion,
  SCOPE_ADHERENCE_V1: "scope-adherence/1.0" as SolFormulaVersion,
} as const;

/**
 * Token efficiency formula spec for the Foreman subject (v1.0).
 * Budget = 150k tokens; 0.0 at 300k tokens.
 */
export const FOREMAN_TOKEN_EFFICIENCY_SPEC: SolTokenEfficiencyFormulaSpec = {
  formula_version: "token-efficiency/1.0",
  budget: 150_000,
  max_penalized: 300_000,
  source_event_type: "bootstrap-context-size",
};

/**
 * Token efficiency formula spec for the Worker subject (v1.0).
 * Budget = 200k tokens; 0.0 at 500k tokens.
 */
export const WORKER_TOKEN_EFFICIENCY_SPEC: SolTokenEfficiencyFormulaSpec = {
  formula_version: "token-efficiency/1.0",
  budget: 200_000,
  max_penalized: 500_000,
  source_event_type: "worker-heartbeat-tokens",
};

/**
 * Quality-per-token formula spec for run-level (Foreman) subject (v1.0).
 */
export const FOREMAN_QUALITY_PER_TOKEN_SPEC: SolQualityPerTokenFormulaSpec = {
  formula_version: "quality-per-token/1.0",
  budget_denominator: 150_000,
  subject: "foreman",
};

/**
 * Quality-per-token formula spec for per-child (Worker) subject (v1.0).
 */
export const WORKER_QUALITY_PER_TOKEN_SPEC: SolQualityPerTokenFormulaSpec = {
  formula_version: "quality-per-token/1.0",
  budget_denominator: 200_000,
  subject: "worker",
};

// ──────────────────────────────────────────────
// Helpers: scorecard construction utilities
// ──────────────────────────────────────────────

/**
 * Build SolRecommendationInputs from a list of subscores and raw metrics.
 * Applies the 0.6 threshold for below_threshold detection.
 */
export function buildRecommendationInputs(
  subscores: SolSubscore[],
  rawMetrics: SolScorecardRawMetrics,
  aggregateScore: number | null,
): SolRecommendationInputs {
  const THRESHOLD = 0.6;
  const lowScoringDimensions = subscores
    .filter((s) => s.score !== null && s.score < 0.5)
    .map((s) => s.dimension);
  const skippedDimensions = subscores
    .filter((s) => s.score === null)
    .map((s) => s.dimension);

  return {
    below_threshold: aggregateScore !== null && aggregateScore < THRESHOLD,
    low_scoring_dimensions: lowScoringDimensions,
    skipped_dimensions: skippedDimensions,
    over_token_budget:
      (rawMetrics.max_bootstrap_tokens !== null && rawMetrics.max_bootstrap_tokens > 150_000) ||
      (rawMetrics.worker_tokens_used !== null && rawMetrics.worker_tokens_used > 200_000),
    intervention_detected:
      rawMetrics.user_intervened === true || rawMetrics.foreman_intervened === true,
    router_issue_detected:
      rawMetrics.router_fallback_used === true || rawMetrics.router_exhausted === true,
    qc_issue_detected:
      (rawMetrics.qc_blocking_findings !== null && rawMetrics.qc_blocking_findings > 0) ||
      rawMetrics.qc_repair_loop_status === "all-providers-failed" ||
      rawMetrics.qc_repair_loop_status === "operator-review",
    notes: [],
  };
}

/**
 * Compute aggregate score from subscores (simple mean of non-null scores).
 * Returns null when all subscores are skipped.
 */
export function computeAggregateScore(subscores: SolSubscore[]): number | null {
  const scored = subscores.filter((s) => s.score !== null);
  if (scored.length === 0) return null;
  const mean = scored.reduce((sum, s) => sum + s.score!, 0) / scored.length;
  return Number(mean.toFixed(4));
}

/**
 * Determine scorecard availability from subscores.
 * "complete" when all subscores have scores; "partial" when some are skipped;
 * "skipped" when all are skipped; "unavailable" when subscores is empty.
 */
export function determineScorecardAvailability(subscores: SolSubscore[]): SolScorecardAvailability {
  if (subscores.length === 0) return "unavailable";
  const scored = subscores.filter((s) => s.score !== null).length;
  if (scored === 0) return "skipped";
  if (scored < subscores.length) return "partial";
  return "complete";
}
