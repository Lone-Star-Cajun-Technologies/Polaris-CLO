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
