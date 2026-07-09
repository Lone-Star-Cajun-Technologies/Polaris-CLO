/**
 * SOL recommendation engine.
 *
 * Generates explainable routing recommendations and Polaris-specific
 * self-improvement proposals from historical SOL score snapshots.
 *
 * Design rules:
 *   - Output is advisory by default; no tracker or filesystem mutation happens
 *     during recommendation generation.
 *   - Filing tracker issues requires an explicit opt-in and is gated to the
 *     Polaris development context (see src/cli/autoresearch.ts).
 *   - Each recommendation carries evidence references, affected routing
 *     dimensions, confidence, and a proposed policy action.
 *   - Deterministic: same snapshot input produces the same recommendation set.
 */

import type { SolScoreSnapshot } from "./sol-history.js";
import { generateReport } from "./sol-report.js";
import type { SolReportGroupBy } from "./sol-report.js";
import type { AutresearchProposal, ArtifactType } from "./proposal.js";
import type { SolEvidence } from "../types/sol-evidence.js";
import type { SolScorecard, SolSubscore, SolSourceRef } from "../types/sol-scorecard.js";

// ──────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────

export interface RecommendationAffected {
  route?: string;
  task_type?: string;
  role?: string;
  provider?: string;
  model?: string;
}

export interface RecommendationEvidence {
  group_key: string;
  grouped_by: SolReportGroupBy[];
  count: number;
  mean_composite: number | null;
  min_composite: number | null;
  max_composite: number | null;
  mean_foreman_composite: number | null;
  mean_worker_composite: number | null;
  run_ids: string[];
}

export interface SolRecommendation {
  /** Deterministic identifier derived from the grouping dimension and value. */
  id: string;
  /** Policy domain this recommendation targets. */
  category:
    | "routing"
    | "provider_policy"
    | "role_assignment"
    | "trust_threshold"
    | "cost_threshold"
    | "runtime_improvement"
    | "scoring_rule"
    | "qc_follow_up";
  /** Review-gated action category: analyze (study) or implement (change). */
  action_type: "analyze" | "implement";
  /** Affected routing dimensions. */
  affected: RecommendationAffected;
  /** Concrete policy action suggested for review. */
  proposed_action: string;
  /** Confidence 0.0–1.0. Higher = stronger signal. */
  confidence: number;
  /** Evidence from historical snapshots. */
  evidence: RecommendationEvidence;
  /** Human-readable rationale. */
  rationale: string;
}

export interface RecommendationOptions {
  /** Mean composite threshold below which a group triggers a recommendation. */
  threshold?: number;
  /** Minimum snapshots in a group before a recommendation is emitted. */
  minSamples?: number;
  /** Dimensions to scan. Default: provider, model, role, route, task_type. */
  groupBy?: SolReportGroupBy[];
}

export interface RecommendationsReport {
  generated_at: string;
  total_snapshots: number;
  threshold: number;
  min_samples: number;
  recommendations: SolRecommendation[];
}

// ──────────────────────────────────────────────
// Constants and helpers
// ──────────────────────────────────────────────

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_MIN_SAMPLES = 2;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function parseGroupKey(groupKey: string): RecommendationAffected {
  const affected: RecommendationAffected = {};
  for (const part of groupKey.split("|")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (!value || value === "unknown") continue;
    if (key === "route") affected.route = value;
    else if (key === "task_type") affected.task_type = value;
    else if (key === "role") affected.role = value;
    else if (key === "provider") affected.provider = value;
    else if (key === "model") affected.model = value;
  }
  return affected;
}

function snapshotGroupKey(snapshot: SolScoreSnapshot, dimension: SolReportGroupBy): string {
  const keys = snapshot.grouping_keys;
  switch (dimension) {
    case "repo":
      return keys.repo ?? "unknown";
    case "route":
      return keys.route ?? "unknown";
    case "task_type":
      return keys.task_type ?? "unknown";
    case "role":
      return keys.role ?? "unknown";
    case "risk":
      return keys.risk ?? "unknown";
    case "provider":
      return keys.provider ?? "unknown";
    case "model":
      return keys.model ?? "unknown";
    case "worker_id":
      return snapshot.worker_ids.length > 0 ? snapshot.worker_ids.join(",") : "unknown";
    case "run_id":
      return snapshot.report.run_id;
    case "time_window": {
      const d = new Date(snapshot.report.scored_at);
      if (isNaN(d.getTime())) return "unknown";
      // Default windowDays = 7 to match generateReport default.
      const WINDOW_DAYS = 7;
      const daysSinceEpoch = Math.floor(d.getTime() / (86400000 * WINDOW_DAYS));
      const bucketStart = new Date(daysSinceEpoch * 86400000 * WINDOW_DAYS);
      return bucketStart.toISOString().slice(0, 10);
    }
  }
}

function groupValueFromLabel(label: string, dimension: SolReportGroupBy): string {
  for (const part of label.split("|")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === dimension) return value ?? "unknown";
  }
  return "unknown";
}

function isWorkerSignal(evidence: RecommendationEvidence): boolean {
  const workerMean = evidence.mean_worker_composite ?? null;
  const foremanMean = evidence.mean_foreman_composite ?? null;
  if (workerMean === null || foremanMean === null) return true; // default to worker-facing
  return workerMean <= foremanMean;
}

function buildProposedAction(
  dimension: SolReportGroupBy,
  affected: RecommendationAffected,
  evidence: RecommendationEvidence,
): string {
  const target =
    affected.provider ?? affected.model ?? affected.role ?? affected.route ?? affected.task_type ?? dimension;
  const workerFocus = isWorkerSignal(evidence);

  switch (dimension) {
    case "provider":
      return `Review provider eligibility and role assignment for provider '${target}'; consider updating execution.providerPolicy or provider trust/cost thresholds.`;
    case "model":
      return `Review model selection for model '${target}'; update role model mapping if the trend persists.`;
    case "role":
      return `Review role assignment for role '${target}'; verify provider capabilities, packet scope, and routing policy.`;
    case "route":
      return workerFocus
        ? `Analyze route health for '${target}'; inspect worker templates and validation commands.`
        : `Analyze route health for '${target}'; inspect scoring rules and foreman/runtime configuration.`;
    case "task_type":
      return `Review task-type routing for '${target}'; verify provider capabilities and role mapping.`;
    case "risk":
      return `Review trust/cost thresholds for risk tier '${target}'; adjust policy filters if this tier is consistently underperforming.`;
    case "worker_id":
      return `Review worker behavior for '${target}'; consider tightening packet scope or validation commands.`;
    default:
      return `Investigate ${workerFocus ? "worker" : "runtime"} performance for '${target}' and update the relevant ${workerFocus ? "worker template/policy" : "runtime config/scoring rules"}.`;
  }
}

function categoryFor(dimension: SolReportGroupBy): SolRecommendation["category"] {
  const map: Partial<Record<SolReportGroupBy, SolRecommendation["category"]>> = {
    provider: "provider_policy",
    model: "provider_policy",
    role: "role_assignment",
    route: "routing",
    task_type: "routing",
    repo: "routing",
    risk: "trust_threshold",
  };
  return map[dimension] ?? "runtime_improvement";
}

function actionTypeFor(evidence: RecommendationEvidence): SolRecommendation["action_type"] {
  return isWorkerSignal(evidence) ? "implement" : "analyze";
}

function artifactTypeFor(
  dimension: SolReportGroupBy,
  evidence: RecommendationEvidence,
): ArtifactType {
  const workerFocus = isWorkerSignal(evidence);
  switch (dimension) {
    case "provider":
    case "model":
      return "provider-role-recommendation";
    case "route":
      return workerFocus ? "worker-template" : "scoring-rule";
    case "task_type":
    case "role":
    case "risk":
      return workerFocus ? "worker-template" : "runtime-config";
    case "repo":
    case "worker_id":
    case "run_id":
    case "time_window":
    default:
      return workerFocus ? "worker-template" : "runtime-config";
  }
}

function confidenceFor(mean: number, threshold: number, count: number): number {
  const gap = Math.max(0, threshold - mean);
  const sampleBoost = Math.min(count / 10, 0.2);
  return clamp01(gap + sampleBoost);
}

// ──────────────────────────────────────────────
// Recommendation generation
// ──────────────────────────────────────────────

/**
 * Scan historical SOL snapshots for underperforming groups and emit
 * review-gated recommendations.
 *
 * The function is pure: it does not read files, call APIs, or mutate inputs.
 */
export function generateRecommendations(
  snapshots: SolScoreSnapshot[],
  options: RecommendationOptions = {},
): RecommendationsReport {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;
  const dimensions: SolReportGroupBy[] =
    options.groupBy ?? ["provider", "model", "role", "route", "task_type"];
  const recommendations: SolRecommendation[] = [];

  for (const dim of dimensions) {
    const report = generateReport(snapshots, { groupBy: [dim] });
    for (const group of report.groups) {
      const mean = group.mean_composite;
      if (mean === null || mean >= threshold || group.count < minSamples) continue;

      const affected = parseGroupKey(group.group_key);
      const evidence: RecommendationEvidence = {
        group_key: group.group_key,
        grouped_by: [dim],
        count: group.count,
        mean_composite: group.mean_composite,
        min_composite: group.min_composite,
        max_composite: group.max_composite,
        mean_foreman_composite: group.mean_foreman_composite,
        mean_worker_composite: group.mean_worker_composite,
        run_ids: [
          ...new Set(
            snapshots
              .filter((s) => snapshotGroupKey(s, dim) === groupValueFromLabel(group.group_key, dim))
              .map((s) => s.report.run_id),
          ),
        ].sort(),
      };

      recommendations.push({
        id: `${dim}:${group.group_key}`,
        category: categoryFor(dim),
        action_type: actionTypeFor(evidence),
        affected,
        proposed_action: buildProposedAction(dim, affected, evidence),
        confidence: confidenceFor(mean, threshold, group.count),
        evidence,
        rationale: `Mean composite score ${mean.toFixed(4)} is below threshold ${threshold.toFixed(2)} across ${group.count} snapshots.`,
      });
    }
  }

  // Deterministic ordering: highest confidence first, then stable id sort.
  recommendations.sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));

  return {
    generated_at: new Date().toISOString(),
    total_snapshots: snapshots.length,
    threshold,
    min_samples: minSamples,
    recommendations,
  };
}

// ──────────────────────────────────────────────
// Proposal conversion (tracker filing)
// ──────────────────────────────────────────────

/**
 * Convert a single recommendation into an AutresearchProposal suitable for
 * `routeProposals()`. This is the bridge from advisory SOL output to
 * review-gated tracker issues.
 */
export function recommendationToProposal(
  recommendation: SolRecommendation,
  runId?: string,
): AutresearchProposal {
  const { evidence, affected, proposed_action, confidence, id, action_type, rationale } =
    recommendation;
  const dim = evidence.grouped_by[0] ?? "run_id";
  const artifactType = artifactTypeFor(dim, evidence);
  const affectedLabel =
    affected.provider ?? affected.model ?? affected.role ?? affected.route ?? affected.task_type ?? dim;
  const gateId = `sol-recommendation:${id}`;

  return {
    gate_id: gateId,
    artifact_type: artifactType,
    hint: `[${action_type}] ${proposed_action}\n\nRationale: ${rationale}\nEvidence: group=${evidence.group_key}, mean=${evidence.mean_composite?.toFixed(4) ?? "N/A"}, count=${evidence.count}, run_ids=${evidence.run_ids.join(",")}`,
    run_id: runId ?? evidence.run_ids[0] ?? "sol-history",
    evidence_run_ids: evidence.run_ids,
    confidence,
    fix_zone: `${artifactType}/${gateId}`,
  };
}

/**
 * Convert recommendations to tracker proposals.
 */
export function recommendationsToProposals(
  recommendations: SolRecommendation[],
  runId?: string,
): AutresearchProposal[] {
  return recommendations.map((r) => recommendationToProposal(r, runId));
}

// ──────────────────────────────────────────────
// Human-readable formatter
// ──────────────────────────────────────────────

function fmtScore(v: number | null): string {
  return v !== null ? v.toFixed(4) : "N/A";
}

function fmtAffected(affected: RecommendationAffected): string {
  const parts: string[] = [];
  if (affected.provider) parts.push(`provider=${affected.provider}`);
  if (affected.model) parts.push(`model=${affected.model}`);
  if (affected.role) parts.push(`role=${affected.role}`);
  if (affected.route) parts.push(`route=${affected.route}`);
  if (affected.task_type) parts.push(`task_type=${affected.task_type}`);
  return parts.length > 0 ? parts.join(", ") : "global";
}

export function formatRecommendationsCli(report: RecommendationsReport): string {
  const lines: string[] = [];
  lines.push("SOL Routing Recommendations");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Total snapshots: ${report.total_snapshots}`);
  lines.push(`Threshold: ${report.threshold.toFixed(2)}, min samples: ${report.min_samples}`);
  lines.push("");

  if (report.recommendations.length === 0) {
    lines.push("No underperforming groups detected.");
    return lines.join("\n") + "\n";
  }

  for (const r of report.recommendations) {
    lines.push(`[${r.action_type}] ${r.id}`);
    lines.push(`  Category:    ${r.category}`);
    lines.push(`  Affected:    ${fmtAffected(r.affected)}`);
    lines.push(`  Confidence:  ${(r.confidence * 100).toFixed(1)}%`);
    lines.push(`  Evidence:    ${r.evidence.group_key} | mean=${fmtScore(r.evidence.mean_composite)} min=${fmtScore(r.evidence.min_composite)} max=${fmtScore(r.evidence.max_composite)} count=${r.evidence.count}`);
    lines.push(`  Action:      ${r.proposed_action}`);
    lines.push(`  Rationale:   ${r.rationale}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────
// QC follow-up recommendations
// ──────────────────────────────────────────────

export interface QcRecommendationsReport {
  generated_at: string;
  evidence_run_id: string;
  recommendations: SolRecommendation[];
}

function makeQcRecommendation(
  id: string,
  category: SolRecommendation["category"],
  actionType: SolRecommendation["action_type"],
  affected: RecommendationAffected,
  proposedAction: string,
  rationale: string,
  confidence: number,
  evidenceRunId: string,
): SolRecommendation {
  return {
    id,
    category,
    action_type: actionType,
    affected,
    proposed_action: proposedAction,
    confidence: clamp01(confidence),
    evidence: {
      group_key: `run_id=${evidenceRunId}`,
      grouped_by: ["run_id"],
      count: 1,
      mean_composite: null,
      min_composite: null,
      max_composite: null,
      mean_foreman_composite: null,
      mean_worker_composite: null,
      run_ids: [evidenceRunId],
    },
    rationale,
  };
}

/**
 * Generate QC repair-loop follow-up recommendations from a single run's
 * SOL evidence. These are advisory signals for noisy providers, repeated
 * repair failures, unresolved high-severity findings, and max-round exhaustion.
 */
export function generateQcRecommendations(evidence: SolEvidence): QcRecommendationsReport {
  const recommendations: SolRecommendation[] = [];
  const qc = evidence.qc;
  const runId = evidence.run_id;

  if (qc.availability !== "available") {
    return {
      generated_at: new Date().toISOString(),
      evidence_run_id: runId,
      recommendations,
    };
  }

  for (const provider of qc.noisy_providers) {
    const counts = qc.provider_breakdown[provider] ?? { total: 0, blocking: 0, unvalidated: 0 };
    const confidence = counts.total > 0 ? counts.unvalidated / counts.total : 0;
    recommendations.push(
      makeQcRecommendation(
        `qc-noisy-provider:${provider}`,
        "provider_policy",
        "analyze",
        { provider },
        `Review QC provider '${provider}' for noisy/unvalidated findings; consider raising attribution confidence thresholds or disabling the provider for high-risk routes.`,
        `${counts.unvalidated}/${counts.total} findings from '${provider}' are unvalidated noise.`,
        confidence,
        runId,
      ),
    );
  }

  if (qc.has_repair_failures) {
    const failed = qc.repair_loop?.packets_failed ?? 0;
    recommendations.push(
      makeQcRecommendation(
        `qc-repair-failure:${runId}`,
        "qc_follow_up",
        "implement",
        {},
        "Repeated repair worker failures detected — inspect repair packet scope, validation commands, and Medic referral path.",
        `${failed} repair packet(s) failed; consider tightening acceptance criteria or escalating to Medic.`,
        0.9,
        runId,
      ),
    );
  }

  if (qc.unresolved_high_severity > 0) {
    recommendations.push(
      makeQcRecommendation(
        `qc-unresolved-high-severity:${runId}`,
        "qc_follow_up",
        "analyze",
        {},
        `${qc.unresolved_high_severity} unresolved critical/high QC findings remain — triage before delivery.`,
        `${qc.unresolved_high_severity} critical/high findings are still open after repair loop.`,
        Math.min(1, qc.unresolved_high_severity / 5),
        runId,
      ),
    );
  }

  if (qc.max_round_exhausted) {
    recommendations.push(
      makeQcRecommendation(
        `qc-max-rounds:${runId}`,
        "qc_follow_up",
        "analyze",
        {},
        "QC repair loop exhausted max rounds — review provider noise, repair packet scope, and escalation policy.",
        `Repair loop reached round ${qc.repair_loop?.rounds_completed ?? 0}/${qc.repair_loop?.max_rounds ?? 0} without passing.`,
        0.85,
        runId,
      ),
    );
  }

  return {
    generated_at: new Date().toISOString(),
    evidence_run_id: runId,
    recommendations,
  };
}

export function formatQcRecommendations(report: QcRecommendationsReport): string {
  const lines: string[] = [];
  lines.push("SOL QC Follow-Up Recommendations");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`Run: ${report.evidence_run_id}`);
  lines.push("");

  if (report.recommendations.length === 0) {
    lines.push("No QC follow-up signals detected.");
    return lines.join("\n") + "\n";
  }

  for (const r of report.recommendations) {
    lines.push(`[${r.action_type}] ${r.id}`);
    lines.push(`  Category:    ${r.category}`);
    lines.push(`  Affected:    ${fmtAffected(r.affected)}`);
    lines.push(`  Confidence:  ${(r.confidence * 100).toFixed(1)}%`);
    lines.push(`  Action:      ${r.proposed_action}`);
    lines.push(`  Rationale:   ${r.rationale}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ──────────────────────────────────────────────
// Scorecard → recommendation input bridge
// ──────────────────────────────────────────────

/**
 * Verdict indicating whether outcome data supports, contradicts, or is
 * inconclusive about the current routing assignment.
 *
 * - "supported":    Evidence confirms the current route/provider/model choice.
 * - "contradicted": Evidence contradicts it (failures, blocked outcomes, QC blocks).
 * - "inconclusive": Insufficient or mixed signal; manual review advised.
 */
export type ScorecardVerdict = "supported" | "contradicted" | "inconclusive";

/**
 * Quality-per-token evidence extracted from a scorecard subscore.
 */
export interface QualityPerTokenEvidence {
  score: number | null;
  detail: string | null;
}

/**
 * QC evidence extracted from a scorecard's subscores and raw metrics.
 */
export interface ScorecardQcEvidence {
  qc_findings: number | null;
  blocking_findings: number | null;
  qc_repair_status: string | null;
  qc_score: number | null;
}

/**
 * Validation evidence extracted from a scorecard.
 */
export interface ScorecardValidationEvidence {
  validation_outcome: string | null;
  passed_commands: string[];
  validation_score: number | null;
}

/**
 * A recommendation input summary derived from a single SolScorecard.
 *
 * Produced by `scorecardToRecommendationSummary`. This is the bridge from
 * durable scorecard artifacts to advisory routing recommendation inputs.
 *
 * Design rules:
 *   - Read-only: does not modify the scorecard or any runtime state.
 *   - Advisory: verdict and confidence are inputs to human review, never
 *     applied automatically.
 *   - The originating scorecard is referenced by scorecard_id and subject_key,
 *     not embedded, to avoid duplication.
 */
export interface ScorecardRecommendationSummary {
  /** Originating scorecard identifier. */
  scorecard_id: string;
  /** Subject type (foreman | worker | provider | model | routing). */
  subject: SolScorecard["subject"];
  /** Subject key (provider name, model name, child ID, etc.). */
  subject_key: string;
  /** Affected routing dimensions derived from scorecard grouping keys. */
  affected: RecommendationAffected;
  /** Advisory verdict based on aggregate score and confirmed_signal subscore. */
  verdict: ScorecardVerdict;
  /** Aggregate score (0.0–1.0) or null if all subscores skipped. */
  aggregate_score: number | null;
  /** Confidence (0.0–1.0) in this summary's verdict. */
  confidence: number;
  /** Low-scoring dimensions (score < 0.5). */
  low_scoring_dimensions: string[];
  /** Quality-per-token evidence. */
  quality_per_token: QualityPerTokenEvidence;
  /** QC evidence. */
  qc: ScorecardQcEvidence;
  /** Validation evidence. */
  validation: ScorecardValidationEvidence;
  /** Source references from the originating scorecard. */
  source_refs: SolSourceRef[];
  /** Whether any intervention signal was detected. */
  intervention_detected: boolean;
  /** Whether router exhaustion or fallback was observed. */
  router_issue_detected: boolean;
}

// ── Internal helpers ──

function extractQptEvidence(subscores: SolSubscore[]): QualityPerTokenEvidence {
  const s = subscores.find((ss) => ss.dimension === "quality_per_token");
  return { score: s?.score ?? null, detail: s?.detail ?? null };
}

function extractQcEvidence(
  subscores: SolSubscore[],
  rawMetrics: SolScorecard["raw_metrics"],
): ScorecardQcEvidence {
  const qcSub = subscores.find(
    (ss) => ss.dimension === "qc" || ss.dimension === "qc_repair_loop" || ss.dimension === "qc_result",
  );
  return {
    qc_findings: rawMetrics.qc_total_findings,
    blocking_findings: rawMetrics.qc_blocking_findings,
    qc_repair_status: rawMetrics.qc_repair_loop_status,
    qc_score: qcSub?.score ?? null,
  };
}

function extractValidationEvidence(
  subscores: SolSubscore[],
  rawMetrics: SolScorecard["raw_metrics"],
): ScorecardValidationEvidence {
  const valSub = subscores.find(
    (ss) =>
      ss.dimension === "validation" ||
      ss.dimension === "evidence_validation" ||
      ss.dimension === "validation_result",
  );
  return {
    validation_outcome: rawMetrics.validation_outcome,
    passed_commands: [...(rawMetrics.passed_commands ?? [])],
    validation_score: valSub?.score ?? null,
  };
}

function deriveVerdict(
  scorecard: SolScorecard,
  qcEvidence: ScorecardQcEvidence,
): ScorecardVerdict {
  const { subscores, aggregate_score, recommendation_inputs } = scorecard;

  // Blocking QC findings always contradict.
  if ((qcEvidence.blocking_findings ?? 0) > 0) return "contradicted";

  // confirmed_signal subscore is the strongest direct verdict signal.
  const confirmed = subscores.find((s) => s.dimension === "confirmed_signal");
  if (confirmed !== undefined && confirmed.score !== null) {
    if (confirmed.score >= 0.9) return "supported";
    if (confirmed.score <= 0.1) return "contradicted";
  }

  // Aggregate score determines verdict; intervention/router issues limit to inconclusive.
  if (aggregate_score !== null) {
    if (aggregate_score < 0.5) return "contradicted";
    if (
      aggregate_score >= 0.75 &&
      !recommendation_inputs.intervention_detected &&
      !recommendation_inputs.router_issue_detected
    ) {
      return "supported";
    }
  }

  if (recommendation_inputs.intervention_detected || recommendation_inputs.router_issue_detected) {
    return "inconclusive";
  }

  if (aggregate_score === null) return "inconclusive";
  if (aggregate_score >= 0.75) return "supported";
  if (aggregate_score < 0.6) return "contradicted";
  return "inconclusive";
}

function confidenceFromScorecard(scorecard: SolScorecard): number {
  const { subscores, aggregate_score, recommendation_inputs } = scorecard;
  const scoredCount = subscores.filter((s) => s.score !== null).length;
  if (scoredCount === 0) return 0.1; // minimal confidence without evidence

  // Base: proportion of subscores with data.
  const coverage = scoredCount / Math.max(subscores.length, 1);
  // Small penalty when below threshold (more uncertainty in the recommendation).
  const scorePenalty = aggregate_score !== null && recommendation_inputs.below_threshold ? 0.1 : 0;
  return clamp01(coverage - scorePenalty);
}

function affectedFromScorecard(scorecard: SolScorecard): RecommendationAffected {
  const keys = scorecard.grouping_keys ?? {};
  const affected: RecommendationAffected = {};
  if (keys.route) affected.route = keys.route;
  if (keys.task_type) affected.task_type = keys.task_type;
  if (keys.role) affected.role = keys.role;
  if (keys.provider) affected.provider = keys.provider;
  if (keys.model) affected.model = keys.model;
  // Subject-level key as fallback for provider/model scorecards.
  if (!affected.provider && scorecard.subject === "provider") affected.provider = scorecard.subject_key;
  if (!affected.model && scorecard.subject === "model") affected.model = scorecard.subject_key;
  return affected;
}

/**
 * Derive a `ScorecardRecommendationSummary` from a `SolScorecard`.
 *
 * This is a pure function: it does not read files, call APIs, or mutate
 * the scorecard or any runtime state. Its output is advisory by default.
 */
export function scorecardToRecommendationSummary(
  scorecard: SolScorecard,
): ScorecardRecommendationSummary {
  const { subscores, raw_metrics, source_refs, recommendation_inputs } = scorecard;

  const qc = extractQcEvidence(subscores, raw_metrics);
  const validation = extractValidationEvidence(subscores, raw_metrics);
  const quality_per_token = extractQptEvidence(subscores);
  const verdict = deriveVerdict(scorecard, qc);
  const confidence = confidenceFromScorecard(scorecard);
  const affected = affectedFromScorecard(scorecard);
  const clonedSourceRefs = source_refs.map((ref) => ({ ...ref }));

  return {
    scorecard_id: scorecard.scorecard_id,
    subject: scorecard.subject,
    subject_key: scorecard.subject_key,
    affected,
    verdict,
    aggregate_score: scorecard.aggregate_score,
    confidence,
    low_scoring_dimensions: [...recommendation_inputs.low_scoring_dimensions],
    quality_per_token,
    qc,
    validation,
    source_refs: clonedSourceRefs,
    intervention_detected: recommendation_inputs.intervention_detected,
    router_issue_detected: recommendation_inputs.router_issue_detected,
  };
}

/**
 * Derive recommendation summaries from a set of scorecards.
 * Returns all summaries; callers filter by verdict as needed.
 */
export function scorecardsToRecommendationSummaries(
  scorecards: SolScorecard[],
): ScorecardRecommendationSummary[] {
  return scorecards.map(scorecardToRecommendationSummary);
}
