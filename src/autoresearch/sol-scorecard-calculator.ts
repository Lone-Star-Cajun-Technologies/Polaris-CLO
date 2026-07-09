/**
 * SOL scorecard calculator.
 *
 * Computes durable, versioned scorecards for SOL evaluation subjects:
 * Foreman, worker, provider, model, and routing decisions.
 *
 * Design rules:
 *   - Reuses the existing SolScoreReport scoring logic where available to
 *     avoid conflicting formulas (POL-481).
 *   - Each scorecard preserves raw metrics and carries formula versions.
 *   - Missing evidence results in skipped subscores with reasons.
 *   - No routing policy or provider selection behavior is changed.
 *
 * Scope: src/autoresearch/**
 */

import type { SolEvidence, SolChildEvidence, SolRouterDecisionEvidence } from "../types/sol-evidence.js";
import type {
  SolScorecard,
  SolSubscore,
  SolScorecardRawMetrics,
  SolSourceRef,
  SolScorecardWindow,
} from "../types/sol-scorecard.js";
import type { SolGroupingKeys } from "../types/sol-evidence.js";
import {
  SOL_FORMULA_VERSIONS,
  computeAggregateScore,
  determineScorecardAvailability,
  buildRecommendationInputs,
  FOREMAN_TOKEN_EFFICIENCY_SPEC,
  WORKER_TOKEN_EFFICIENCY_SPEC,
  FOREMAN_QUALITY_PER_TOKEN_SPEC,
  WORKER_QUALITY_PER_TOKEN_SPEC,
} from "../types/sol-scorecard.js";
import type { SolScoreConfidence, SolDimensionScore } from "../types/sol-score.js";
import { computeForemanScore, computeWorkerScore } from "./sol-scorer.js";
import { buildDefaultEvidenceSourceRefs } from "./sol-evidence-normalizer.js";

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function subscore(
  dimension: string,
  formulaVersion: string,
  score: number | null,
  confidence: SolScoreConfidence,
  opts: { skipped_reason?: string; detail?: string } = {},
): SolSubscore {
  return { dimension, formula_version: formulaVersion, score, confidence, ...opts };
}

function skippedSubscore(dimension: string, formulaVersion: string, reason: string): SolSubscore {
  return subscore(dimension, formulaVersion, null, "none", { skipped_reason: reason });
}

function toSolSubscore(dim: SolDimensionScore, formulaVersion: string): SolSubscore {
  return {
    dimension: dim.dimension,
    formula_version: formulaVersion,
    score: dim.score,
    confidence: dim.confidence,
    skipped_reason: dim.skipped_reason,
    detail: dim.detail,
  };
}

function confidenceFromCount(count: number): SolScoreConfidence {
  if (count >= 5) return "high";
  if (count >= 2) return "medium";
  return "low";
}

function makeWindow(ev: SolEvidence): SolScorecardWindow {
  return {
    run_id: ev.run_id,
    cluster_id: ev.cluster_id ?? undefined,
    sample_count: ev.run.total_children > 0 ? ev.run.total_children : undefined,
  };
}

// ──────────────────────────────────────────────
// Raw metric builders
// ──────────────────────────────────────────────

function emptyRawMetrics(): SolScorecardRawMetrics {
  return {
    max_bootstrap_tokens: null,
    worker_tokens_used: null,
    dispatch_epoch: null,
    continue_epoch: null,
    total_children: null,
    workers_succeeded: null,
    workers_failed: null,
    redispatch_count: null,
    validation_outcome: null,
    passed_commands: [],
    qc_total_findings: null,
    qc_blocking_findings: null,
    qc_repaired_findings: null,
    qc_repair_loop_status: null,
    qc_repair_rounds: null,
    escalation_count: null,
    out_of_scope_count: null,
    user_intervened: null,
    foreman_intervened: null,
    state_repair_required: null,
    provider_selected: null,
    router_fallback_used: null,
    router_exhausted: null,
    router_exhausted_reason: null,
    provider_decisions: null,
    provider_startup_failures: null,
    provider_exhausted_decisions: null,
    provider_fallback_attempts: null,
    provider_successful_fallbacks: null,
    model_decisions: null,
    model_startup_failures: null,
    model_exhausted_decisions: null,
    model_fallback_attempts: null,
    model_successful_fallbacks: null,
    router_candidates_count: null,
    router_child_status: null,
    router_child_validation: null,
    heartbeat_count: null,
  };
}

export function buildForemanRawMetrics(ev: SolEvidence): SolScorecardRawMetrics {
  const run = ev.run;
  const foreman = ev.foreman;
  const worker = ev.worker;
  const intervention = ev.intervention;

  return {
    ...emptyRawMetrics(),
    max_bootstrap_tokens: foreman.max_bootstrap_tokens,
    dispatch_epoch: run.dispatch_epoch,
    continue_epoch: run.continue_epoch,
    total_children: run.total_children,
    workers_succeeded: worker.workers_succeeded,
    workers_failed: worker.workers_failed,
    redispatch_count: foreman.redispatch_count,
    qc_total_findings: ev.qc.total_findings,
    qc_blocking_findings: ev.qc.blocking_findings,
    qc_repaired_findings: ev.qc.repaired_findings,
    qc_repair_loop_status: ev.qc.repair_loop?.status ?? null,
    qc_repair_rounds: ev.qc.repair_loop
      ? { completed: ev.qc.repair_loop.rounds_completed, max: ev.qc.repair_loop.max_rounds }
      : null,
    escalation_count: foreman.escalation_events,
    out_of_scope_count: intervention.out_of_scope_count,
    user_intervened: intervention.user_intervened,
    foreman_intervened: intervention.foreman_intervened,
    state_repair_required: intervention.state_repair_required,
    heartbeat_count: worker.total_heartbeats,
  };
}

export function buildWorkerRawMetrics(ev: SolEvidence, child: SolChildEvidence): SolScorecardRawMetrics {
  const validation = ev.validation.find((v) => v.child_id === child.child_id);

  return {
    ...emptyRawMetrics(),
    worker_tokens_used: ev.tokens.tokens_by_child[child.child_id] ?? null,
    validation_outcome: validation?.outcome ?? child.validation,
    passed_commands: validation?.passed_commands ?? [],
    qc_total_findings: ev.qc.total_findings,
    qc_blocking_findings: ev.qc.blocking_findings,
    qc_repaired_findings: ev.qc.repaired_findings,
    qc_repair_loop_status: ev.qc.repair_loop?.status ?? null,
    escalation_count: child.escalation_count,
    user_intervened: child.user_intervened,
    foreman_intervened: child.foreman_intervened,
    heartbeat_count: child.heartbeat_count,
  };
}

type AggregateSubject = "provider" | "model";

interface AggregateSubjectStats {
  children: SolChildEvidence[];
  decisions: SolRouterDecisionEvidence[];
  startupFailures: number;
  exhaustedDecisions: number;
  fallbackAttempts: number;
  successfulFallbacks: number;
  succeeded: number;
  failed: number;
  blocked: number;
  totalHeartbeats: number;
  totalTokens: number;
  validationPasses: number;
  validationFailures: number;
}

function aggregateForSubject(
  ev: SolEvidence,
  children: SolChildEvidence[],
  decisions: SolRouterDecisionEvidence[],
  classifyDecision: (
    decision: SolRouterDecisionEvidence,
    child: SolChildEvidence | undefined,
  ) => { startupFailure: boolean; exhaustedDecision: boolean; fallbackAttempt: boolean },
): AggregateSubjectStats {
  let startupFailures = 0;
  let exhaustedDecisions = 0;
  let fallbackAttempts = 0;
  let successfulFallbacks = 0;

  for (const decision of decisions) {
    const child = ev.children.find((candidate) => candidate.child_id === decision.child_id);
    const classification = classifyDecision(decision, child);
    if (classification.startupFailure) startupFailures++;
    if (classification.exhaustedDecision) exhaustedDecisions++;
    if (classification.fallbackAttempt) {
      fallbackAttempts++;
      if (child && child.status === "done") successfulFallbacks++;
    }
  }

  let succeeded = 0;
  let failed = 0;
  let blocked = 0;
  let totalHeartbeats = 0;
  let totalTokens = 0;
  let validationPasses = 0;
  let validationFailures = 0;

  for (const child of children) {
    if (child.status === "done") succeeded++;
    else if (child.status === "failed" || child.status === "error") failed++;
    else if (child.status === "blocked") blocked++;
    totalHeartbeats += child.heartbeat_count;
    totalTokens += ev.tokens.tokens_by_child[child.child_id] ?? 0;
    const validation = ev.validation.find((val) => val.child_id === child.child_id);
    const outcome = validation?.outcome ?? child.validation;
    if (outcome === "passed") validationPasses++;
    else if (outcome === "failed") validationFailures++;
  }

  return {
    children,
    decisions,
    startupFailures,
    exhaustedDecisions,
    fallbackAttempts,
    successfulFallbacks,
    succeeded,
    failed,
    blocked,
    totalHeartbeats,
    totalTokens,
    validationPasses,
    validationFailures,
  };
}

function buildAggregateRawMetrics(
  ev: SolEvidence,
  subject: AggregateSubject,
  subjectKey: string,
  agg: AggregateSubjectStats,
): SolScorecardRawMetrics {
  const decisionField = subject === "provider" ? "provider_decisions" : "model_decisions";
  const startupField = subject === "provider" ? "provider_startup_failures" : "model_startup_failures";
  const exhaustedField = subject === "provider" ? "provider_exhausted_decisions" : "model_exhausted_decisions";
  const fallbackField = subject === "provider" ? "provider_fallback_attempts" : "model_fallback_attempts";
  const successfulFallbackField =
    subject === "provider" ? "provider_successful_fallbacks" : "model_successful_fallbacks";

  return {
    ...emptyRawMetrics(),
    total_children: agg.children.length,
    workers_succeeded: agg.succeeded,
    workers_failed: agg.failed,
    worker_tokens_used: agg.totalTokens > 0 ? agg.totalTokens : null,
    validation_outcome: agg.validationPasses > 0 || agg.validationFailures > 0
      ? agg.validationFailures === 0
        ? "passed"
        : "failed"
      : null,
    passed_commands: agg.validationFailures === 0 && agg.validationPasses > 0 ? ["aggregate"] : [],
    qc_total_findings: ev.qc.total_findings,
    qc_blocking_findings: ev.qc.blocking_findings,
    provider_selected: subject === "provider" ? subjectKey : null,
    [decisionField]: agg.decisions.length,
    [startupField]: agg.startupFailures,
    [exhaustedField]: agg.exhaustedDecisions,
    [fallbackField]: agg.fallbackAttempts,
    [successfulFallbackField]: agg.successfulFallbacks,
    heartbeat_count: agg.totalHeartbeats > 0 ? agg.totalHeartbeats : null,
  };
}

function aggregateForProvider(
  ev: SolEvidence,
  provider: string,
): AggregateSubjectStats {
  const children = ev.children.filter((c) => c.provider === provider);
  const decisions = ev.router.decisions.filter(
    (d) => d.selected_provider === provider || d.providers_tried.includes(provider),
  );

  return aggregateForSubject(ev, children, decisions, (decision) => {
    const finalProvider = decision.selected_provider ?? decision.providers_tried[decision.providers_tried.length - 1];
    return {
      startupFailure: decision.exhausted && finalProvider === provider,
      exhaustedDecision: decision.exhausted && decision.providers_tried.includes(provider),
      fallbackAttempt: decision.fallback_used && decision.providers_tried.includes(provider),
    };
  });
}

export function buildProviderRawMetrics(ev: SolEvidence, provider: string): SolScorecardRawMetrics {
  return buildAggregateRawMetrics(ev, "provider", provider, aggregateForProvider(ev, provider));
}

function aggregateForModel(
  ev: SolEvidence,
  model: string,
): AggregateSubjectStats {
  const children = ev.children.filter((c) => c.grouping_keys.model === model);
  // Model attribution on router decisions is best-effort via child grouping keys.
  const childIds = new Set(children.map((c) => c.child_id));
  const decisions = ev.router.decisions.filter((d) => childIds.has(d.child_id));

  return aggregateForSubject(ev, children, decisions, (decision) => ({
    startupFailure: decision.exhausted,
    exhaustedDecision: decision.exhausted,
    fallbackAttempt: decision.fallback_used,
  }));
}

export function buildModelRawMetrics(ev: SolEvidence, model: string): SolScorecardRawMetrics {
  return buildAggregateRawMetrics(ev, "model", model, aggregateForModel(ev, model));
}

export function buildRoutingRawMetrics(
  ev: SolEvidence,
  decision: SolRouterDecisionEvidence,
): SolScorecardRawMetrics {
  const child = ev.children.find((c) => c.child_id === decision.child_id);
  const validation = ev.validation.find((v) => v.child_id === decision.child_id);

  return {
    ...emptyRawMetrics(),
    total_children: child ? 1 : 0,
    workers_succeeded: child?.status === "done" ? 1 : 0,
    workers_failed: child && (child.status === "failed" || child.status === "error") ? 1 : 0,
    worker_tokens_used: child ? ev.tokens.tokens_by_child[child.child_id] ?? null : null,
    validation_outcome: validation?.outcome ?? child?.validation ?? null,
    passed_commands: validation?.passed_commands ?? [],
    qc_total_findings: ev.qc.total_findings,
    qc_blocking_findings: ev.qc.blocking_findings,
    provider_selected: decision.selected_provider,
    router_fallback_used: decision.fallback_used,
    router_exhausted: decision.exhausted,
    router_exhausted_reason: decision.exhausted_reason,
    router_candidates_count: decision.providers_tried.length,
    router_child_status: child?.status ?? null,
    router_child_validation: validation?.outcome ?? child?.validation ?? null,
    heartbeat_count: child?.heartbeat_count ?? null,
  };
}

// ──────────────────────────────────────────────
// Scorecard assembly
// ──────────────────────────────────────────────

function buildScorecard(
  subject: SolScorecard["subject"],
  subjectKey: string,
  ev: SolEvidence,
  rawMetrics: SolScorecardRawMetrics,
  subscores: SolSubscore[],
  sourceRefs: SolSourceRef[],
  groupingKeys?: SolGroupingKeys,
): SolScorecard {
  const aggregateScore = computeAggregateScore(subscores);
  const availability = determineScorecardAvailability(subscores);
  const availabilityReason =
    availability === "unavailable"
      ? "No scoreable dimensions were produced"
      : availability === "skipped"
        ? "All dimensions were skipped due to missing evidence"
        : undefined;

  const scoredConfidences = subscores
    .filter((s) => s.score !== null)
    .map((s) => s.confidence);
  const aggregateConfidence: SolScoreConfidence =
    scoredConfidences.length === 0
      ? "none"
      : (scoredConfidences.reduce<SolScoreConfidence>((worst, c) => {
          const rank: Record<SolScoreConfidence, number> = { high: 3, medium: 2, low: 1, none: 0 };
          return rank[c] < rank[worst] ? c : worst;
        }, "high"));

  return {
    schema_version: "1.0",
    scorecard_id: `${subject}-${subjectKey}-${ev.run_id}`,
    subject,
    subject_key: subjectKey,
    window: makeWindow(ev),
    grouping_keys: groupingKeys ?? ev.grouping_keys,
    generated_at: new Date().toISOString(),
    availability,
    availability_reason: availabilityReason,
    raw_metrics: rawMetrics,
    subscores,
    aggregate_score: aggregateScore,
    aggregate_confidence: aggregateConfidence,
    source_refs: sourceRefs,
    recommendation_inputs: buildRecommendationInputs(subscores, rawMetrics, aggregateScore),
    aggregate_formula_version: SOL_FORMULA_VERSIONS.COMPOSITE_MEAN_V1,
  };
}

// ──────────────────────────────────────────────
// Foreman scorecard
// ──────────────────────────────────────────────

/**
 * Compute a scorecard for the Foreman subject.
 */
export function computeForemanScorecard(
  ev: SolEvidence,
  sourceRefs?: SolSourceRef[],
  groupingKeys?: SolGroupingKeys,
): SolScorecard {
  const report = computeForemanScore(ev);
  const rawMetrics = buildForemanRawMetrics(ev);

  const subscores: SolSubscore[] = [
    toSolSubscore(report.token, SOL_FORMULA_VERSIONS.TOKEN_EFFICIENCY_V1),
    toSolSubscore(report.duration, SOL_FORMULA_VERSIONS.RUNTIME_PROXY_V1),
    toSolSubscore(report.intervention, SOL_FORMULA_VERSIONS.INTERVENTION_BINARY_V1),
    toSolSubscore(report.dependency, SOL_FORMULA_VERSIONS.DEPENDENCY_RATE_V1),
    toSolSubscore(report.dispatch, SOL_FORMULA_VERSIONS.DISPATCH_RATE_V1),
    toSolSubscore(report.evidence_validation, SOL_FORMULA_VERSIONS.VALIDATION_BINARY_V1),
    toSolSubscore(report.scope, SOL_FORMULA_VERSIONS.SCOPE_ADHERENCE_V1),
    toSolSubscore(report.completion, SOL_FORMULA_VERSIONS.QUALITY_OUTCOMES_V1),
    toSolSubscore(report.recovery, SOL_FORMULA_VERSIONS.RECOVERY_BINARY_V1),
    toSolSubscore(report.qc_repair_loop, SOL_FORMULA_VERSIONS.QC_REPAIR_LOOP_V1),
  ];

  // Quality-per-token is a synthetic dimension for the Foreman scorecard.
  const qpt = computeQualityPerToken(rawMetrics, report.composite_score, FOREMAN_QUALITY_PER_TOKEN_SPEC.budget_denominator);
  if (qpt) subscores.push(qpt);

  return buildScorecard("foreman", ev.run_id, ev, rawMetrics, subscores, sourceRefs ?? buildDefaultEvidenceSourceRefs(ev), groupingKeys);
}

// ──────────────────────────────────────────────
// Worker scorecard
// ──────────────────────────────────────────────

/**
 * Compute a scorecard for a single worker child.
 * Returns null when the child is not found in evidence.
 */
export function computeWorkerScorecard(
  ev: SolEvidence,
  childId: string,
  sourceRefs?: SolSourceRef[],
  groupingKeys?: SolGroupingKeys,
): SolScorecard | null {
  const child = ev.children.find((c) => c.child_id === childId);
  if (!child) return null;

  const report = computeWorkerScore(childId, ev);
  if (!report) return null;

  const rawMetrics = buildWorkerRawMetrics(ev, child);

  const subscores: SolSubscore[] = [
    toSolSubscore(report.token, SOL_FORMULA_VERSIONS.TOKEN_EFFICIENCY_V1),
    toSolSubscore(report.duration, SOL_FORMULA_VERSIONS.RUNTIME_PROXY_V1),
    toSolSubscore(report.validation, SOL_FORMULA_VERSIONS.VALIDATION_BINARY_V1),
    toSolSubscore(report.qc, SOL_FORMULA_VERSIONS.QC_OUTCOME_V1),
    toSolSubscore(report.repair_iterations, SOL_FORMULA_VERSIONS.QC_REPAIR_LOOP_V1),
    toSolSubscore(report.scope_adherence, SOL_FORMULA_VERSIONS.SCOPE_ADHERENCE_V1),
    toSolSubscore(report.acceptance_criteria, SOL_FORMULA_VERSIONS.VALIDATION_BINARY_V1),
    toSolSubscore(report.first_pass, SOL_FORMULA_VERSIONS.INTERVENTION_BINARY_V1),
  ];

  const qpt = computeQualityPerToken(rawMetrics, report.composite_score, WORKER_QUALITY_PER_TOKEN_SPEC.budget_denominator);
  if (qpt) subscores.push(qpt);

  return buildScorecard(
    "worker",
    `${childId}-${ev.run_id}`,
    ev,
    rawMetrics,
    subscores,
    sourceRefs ?? buildDefaultEvidenceSourceRefs(ev),
    groupingKeys ?? child.grouping_keys,
  );
}

function computeQualityPerToken(
  rawMetrics: SolScorecardRawMetrics,
  compositeScore: number | null,
  budget: number,
): SolSubscore | null {
  const tokens = rawMetrics.worker_tokens_used ?? rawMetrics.max_bootstrap_tokens;
  if (tokens === null || compositeScore === null) return null;
  if (tokens <= 0) return null;

  const normalizedCost = tokens / budget;
  const value = compositeScore / normalizedCost;
  // Cap quality-per-token at 2.0 (twice the budget efficiency) and map to 0–1
  const score = clamp01(value / 2.0);
  const confidence: SolScoreConfidence =
    rawMetrics.worker_tokens_used !== null ? "high" : rawMetrics.max_bootstrap_tokens !== null ? "medium" : "low";

  return subscore("quality_per_token", SOL_FORMULA_VERSIONS.QUALITY_PER_TOKEN_V1, Number(score.toFixed(4)), confidence, {
    detail: `composite_score=${compositeScore}, tokens=${tokens}, budget=${budget}`,
  });
}

// ──────────────────────────────────────────────
// Provider scorecard
// ──────────────────────────────────────────────

function subjectDecisions(metrics: SolScorecardRawMetrics, subject: AggregateSubject): number {
  return subject === "provider" ? metrics.provider_decisions ?? 0 : metrics.model_decisions ?? 0;
}

function subjectStartupFailures(metrics: SolScorecardRawMetrics, subject: AggregateSubject): number {
  return subject === "provider" ? metrics.provider_startup_failures ?? 0 : metrics.model_startup_failures ?? 0;
}

function subjectExhaustedDecisions(metrics: SolScorecardRawMetrics, subject: AggregateSubject): number {
  return subject === "provider" ? metrics.provider_exhausted_decisions ?? 0 : metrics.model_exhausted_decisions ?? 0;
}

function subjectFallbackAttempts(metrics: SolScorecardRawMetrics, subject: AggregateSubject): number {
  return subject === "provider" ? metrics.provider_fallback_attempts ?? 0 : metrics.model_fallback_attempts ?? 0;
}

function subjectSuccessfulFallbacks(metrics: SolScorecardRawMetrics, subject: AggregateSubject): number {
  return subject === "provider" ? metrics.provider_successful_fallbacks ?? 0 : metrics.model_successful_fallbacks ?? 0;
}

function scoreAggregateStartupFailure(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const total = subjectDecisions(metrics, subject);
  if (total === 0) return skippedSubscore("startup_failure", SOL_FORMULA_VERSIONS.STARTUP_FAILURE_RATE_V1, `no routing decisions for ${subject}`);
  const failures = subjectStartupFailures(metrics, subject);
  const rate = failures / total;
  const score = clamp01(1.0 - rate);
  return subscore("startup_failure", SOL_FORMULA_VERSIONS.STARTUP_FAILURE_RATE_V1, Number(score.toFixed(4)), confidenceFromCount(total), {
    detail: `startup_failures=${failures}, decisions=${total}`,
  });
}

function scoreAggregateQuotaExhaustion(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const total = subjectDecisions(metrics, subject);
  if (total === 0) return skippedSubscore("quota_exhaustion", SOL_FORMULA_VERSIONS.QUOTA_EXHAUSTION_RATE_V1, `no routing decisions for ${subject}`);
  const exhausted = subjectExhaustedDecisions(metrics, subject);
  const rate = exhausted / total;
  const score = clamp01(1.0 - rate);
  return subscore("quota_exhaustion", SOL_FORMULA_VERSIONS.QUOTA_EXHAUSTION_RATE_V1, Number(score.toFixed(4)), confidenceFromCount(total), {
    detail: `exhausted_decisions=${exhausted}, decisions=${total}`,
  });
}

function scoreAggregateFallbackFrequency(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const total = subjectDecisions(metrics, subject);
  if (total === 0) return skippedSubscore("fallback_frequency", SOL_FORMULA_VERSIONS.FALLBACK_FREQUENCY_V1, `no routing decisions for ${subject}`);
  const fallbacks = subjectFallbackAttempts(metrics, subject);
  const rate = fallbacks / total;
  // More fallbacks = lower score (provider needed help)
  const score = clamp01(1.0 - rate);
  return subscore("fallback_frequency", SOL_FORMULA_VERSIONS.FALLBACK_FREQUENCY_V1, Number(score.toFixed(4)), confidenceFromCount(total), {
    detail: `fallback_attempts=${fallbacks}, successful_fallbacks=${subjectSuccessfulFallbacks(metrics, subject)}, decisions=${total}`,
  });
}

function scoreAggregateRoleSuitability(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const total = metrics.total_children ?? 0;
  if (total === 0) return skippedSubscore("role_suitability", SOL_FORMULA_VERSIONS.ROLE_SUITABILITY_V1, `no children assigned to ${subject}`);
  const succeeded = metrics.workers_succeeded ?? 0;
  const score = clamp01(succeeded / total);
  return subscore("role_suitability", SOL_FORMULA_VERSIONS.ROLE_SUITABILITY_V1, Number(score.toFixed(4)), confidenceFromCount(total), {
    detail: `succeeded=${succeeded}, total=${total}`,
  });
}

function scoreAggregateRuntime(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const hb = metrics.heartbeat_count;
  const total = metrics.total_children ?? 0;
  if (hb === null || total === 0) {
    return skippedSubscore("runtime", SOL_FORMULA_VERSIONS.RUNTIME_PROXY_V1, `no heartbeat evidence for ${subject}`);
  }
  const mean = hb / total;
  // Same proxy as worker duration: 1–10 heartbeats per child ideal
  const EXPECTED_MAX = 10;
  const score = clamp01(mean <= EXPECTED_MAX ? 1.0 : 1.0 - (mean - EXPECTED_MAX) * 0.05);
  return subscore("runtime", SOL_FORMULA_VERSIONS.RUNTIME_PROXY_V1, Number(score.toFixed(4)), confidenceFromCount(total), {
    detail: `mean_heartbeats_per_child=${mean.toFixed(1)}`,
  });
}

function scoreAggregateTokenEfficiency(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const tokens = metrics.worker_tokens_used;
  const total = metrics.total_children ?? 0;
  if (tokens === null || total === 0) {
    return skippedSubscore("token_efficiency", SOL_FORMULA_VERSIONS.TOKEN_EFFICIENCY_V1, `no token evidence for ${subject}`);
  }
  const mean = tokens / total;
  const BUDGET = WORKER_TOKEN_EFFICIENCY_SPEC.budget;
  const MAX_PENALIZED = WORKER_TOKEN_EFFICIENCY_SPEC.max_penalized;
  const score = mean <= BUDGET ? 1.0 : clamp01(1.0 - (mean - BUDGET) / (MAX_PENALIZED - BUDGET));
  return subscore("token_efficiency", SOL_FORMULA_VERSIONS.TOKEN_EFFICIENCY_V1, Number(score.toFixed(4)), "high", {
    detail: `mean_tokens_per_child=${Math.round(mean)}`,
  });
}

function scoreAggregateQualityOutcomes(metrics: SolScorecardRawMetrics, subject: AggregateSubject): SolSubscore {
  const total = metrics.total_children ?? 0;
  if (total === 0) return skippedSubscore("quality_outcomes", SOL_FORMULA_VERSIONS.QUALITY_OUTCOMES_V1, `no children assigned to ${subject}`);
  const succeeded = metrics.workers_succeeded ?? 0;
  const validationOutcome = metrics.validation_outcome;
  const score = validationOutcome === "passed" ? clamp01(succeeded / total) : clamp01(succeeded / total) * 0.8;
  return subscore("quality_outcomes", SOL_FORMULA_VERSIONS.QUALITY_OUTCOMES_V1, Number(score.toFixed(4)), confidenceFromCount(total), {
    detail: `succeeded=${succeeded}, total=${total}, validation_outcome=${validationOutcome ?? "unknown"}`,
  });
}

/**
 * Compute a scorecard for a provider.
 */
export function computeProviderScorecard(
  ev: SolEvidence,
  provider: string,
  sourceRefs?: SolSourceRef[],
  groupingKeys?: SolGroupingKeys,
): SolScorecard {
  const rawMetrics = buildProviderRawMetrics(ev, provider);
  const subscores: SolSubscore[] = [
    scoreAggregateStartupFailure(rawMetrics, "provider"),
    scoreAggregateQuotaExhaustion(rawMetrics, "provider"),
    scoreAggregateFallbackFrequency(rawMetrics, "provider"),
    scoreAggregateRoleSuitability(rawMetrics, "provider"),
    scoreAggregateRuntime(rawMetrics, "provider"),
    scoreAggregateTokenEfficiency(rawMetrics, "provider"),
    scoreAggregateQualityOutcomes(rawMetrics, "provider"),
  ];

  return buildScorecard("provider", provider, ev, rawMetrics, subscores, sourceRefs ?? buildDefaultEvidenceSourceRefs(ev), groupingKeys);
}

// ──────────────────────────────────────────────
// Model scorecard
// ──────────────────────────────────────────────

/**
 * Compute a scorecard for a model.
 */
export function computeModelScorecard(
  ev: SolEvidence,
  model: string,
  sourceRefs?: SolSourceRef[],
  groupingKeys?: SolGroupingKeys,
): SolScorecard {
  const rawMetrics = buildModelRawMetrics(ev, model);
  const subscores: SolSubscore[] = [
    scoreAggregateStartupFailure(rawMetrics, "model"),
    scoreAggregateQuotaExhaustion(rawMetrics, "model"),
    scoreAggregateFallbackFrequency(rawMetrics, "model"),
    scoreAggregateRoleSuitability(rawMetrics, "model"),
    scoreAggregateRuntime(rawMetrics, "model"),
    scoreAggregateTokenEfficiency(rawMetrics, "model"),
    scoreAggregateQualityOutcomes(rawMetrics, "model"),
  ];

  return buildScorecard("model", model, ev, rawMetrics, subscores, sourceRefs ?? buildDefaultEvidenceSourceRefs(ev), groupingKeys);
}

// ──────────────────────────────────────────────
// Routing scorecard
// ──────────────────────────────────────────────

function scoreRouteSelected(metrics: SolScorecardRawMetrics): SolSubscore {
  if (metrics.router_exhausted) {
    return subscore("route_selected", SOL_FORMULA_VERSIONS.ROUTE_SELECTED_V1, 0.0, "high", {
      detail: "router exhausted all providers",
    });
  }
  if (metrics.provider_selected === null) {
    return skippedSubscore("route_selected", SOL_FORMULA_VERSIONS.ROUTE_SELECTED_V1, "no selected provider");
  }
  const status = metrics.router_child_status;
  const score = status === "done" ? 1.0 : status === "blocked" ? 0.0 : 0.5;
  return subscore("route_selected", SOL_FORMULA_VERSIONS.ROUTE_SELECTED_V1, score, "high", {
    detail: `selected_provider=${metrics.provider_selected}, child_status=${status ?? "unknown"}`,
  });
}

function scoreRouteCandidates(metrics: SolScorecardRawMetrics): SolSubscore {
  const count = metrics.router_candidates_count;
  if (count === null) return skippedSubscore("candidates", SOL_FORMULA_VERSIONS.ROUTE_CANDIDATES_V1, "no candidate count");
  // 1 candidate = 0.5; 2 = 0.75; 3+ = 1.0
  const score = count >= 3 ? 1.0 : count === 2 ? 0.75 : 0.5;
  return subscore("candidates", SOL_FORMULA_VERSIONS.ROUTE_CANDIDATES_V1, score, count > 0 ? "high" : "low", {
    detail: `candidates=${count}`,
  });
}

function scoreRouteFallbackPath(metrics: SolScorecardRawMetrics): SolSubscore {
  if (!metrics.router_fallback_used) {
    return subscore("fallback_path", SOL_FORMULA_VERSIONS.ROUTE_FALLBACK_PATH_V1, 1.0, "high", {
      detail: "no fallback used",
    });
  }
  if (metrics.router_exhausted) {
    return subscore("fallback_path", SOL_FORMULA_VERSIONS.ROUTE_FALLBACK_PATH_V1, 0.0, "high", {
      detail: "fallback exhausted",
    });
  }
  const status = metrics.router_child_status;
  const score = status === "done" ? 0.5 : 0.0;
  return subscore("fallback_path", SOL_FORMULA_VERSIONS.ROUTE_FALLBACK_PATH_V1, score, "high", {
    detail: `fallback_used=true, child_status=${status ?? "unknown"}`,
  });
}

function scoreRouteOutcomeQuality(metrics: SolScorecardRawMetrics): SolSubscore {
  const status = metrics.router_child_status;
  const validation = metrics.router_child_validation;
  if (status === null && validation === null) {
    return skippedSubscore("outcome_quality", SOL_FORMULA_VERSIONS.ROUTE_OUTCOME_QUALITY_V1, "no child outcome for routing decision");
  }
  if (status === "done" && validation === "passed") return subscore("outcome_quality", SOL_FORMULA_VERSIONS.ROUTE_OUTCOME_QUALITY_V1, 1.0, "high", { detail: "status=done, validation=passed" });
  if (status === "done") return subscore("outcome_quality", SOL_FORMULA_VERSIONS.ROUTE_OUTCOME_QUALITY_V1, 0.75, "high", { detail: `status=done, validation=${validation ?? "unknown"}` });
  if (status === "blocked") return subscore("outcome_quality", SOL_FORMULA_VERSIONS.ROUTE_OUTCOME_QUALITY_V1, 0.0, "high", { detail: "status=blocked" });
  return subscore("outcome_quality", SOL_FORMULA_VERSIONS.ROUTE_OUTCOME_QUALITY_V1, 0.25, "high", { detail: `status=${status ?? "unknown"}, validation=${validation ?? "unknown"}` });
}

function scoreRouteTokenBurn(metrics: SolScorecardRawMetrics): SolSubscore {
  const tokens = metrics.worker_tokens_used;
  if (tokens === null) {
    return skippedSubscore("token_burn", SOL_FORMULA_VERSIONS.ROUTE_TOKEN_BURN_V1, "no token data for routed child");
  }
  const BUDGET = WORKER_TOKEN_EFFICIENCY_SPEC.budget;
  const MAX_PENALIZED = WORKER_TOKEN_EFFICIENCY_SPEC.max_penalized;
  const score = tokens <= BUDGET ? 1.0 : clamp01(1.0 - (tokens - BUDGET) / (MAX_PENALIZED - BUDGET));
  return subscore("token_burn", SOL_FORMULA_VERSIONS.ROUTE_TOKEN_BURN_V1, Number(score.toFixed(4)), "high", {
    detail: `tokens=${tokens}`,
  });
}

function scoreRouteQcResult(metrics: SolScorecardRawMetrics): SolSubscore {
  const total = metrics.qc_total_findings;
  if (total === null) return skippedSubscore("qc_result", SOL_FORMULA_VERSIONS.ROUTE_QC_RESULT_V1, "no QC evidence");
  const blocking = metrics.qc_blocking_findings ?? 0;
  if (blocking > 0) {
    return subscore("qc_result", SOL_FORMULA_VERSIONS.ROUTE_QC_RESULT_V1, 0.0, "high", {
      detail: `blocking_findings=${blocking}`,
    });
  }
  if (total > 0) {
    return subscore("qc_result", SOL_FORMULA_VERSIONS.ROUTE_QC_RESULT_V1, 0.5, "high", {
      detail: `total_findings=${total}, blocking=0`,
    });
  }
  return subscore("qc_result", SOL_FORMULA_VERSIONS.ROUTE_QC_RESULT_V1, 1.0, "high", { detail: "no QC findings" });
}

function scoreRouteValidationResult(metrics: SolScorecardRawMetrics): SolSubscore {
  const outcome = metrics.router_child_validation ?? metrics.validation_outcome;
  if (outcome === null) {
    return skippedSubscore("validation_result", SOL_FORMULA_VERSIONS.ROUTE_VALIDATION_RESULT_V1, "no validation outcome for routed child");
  }
  if (outcome === "passed") return subscore("validation_result", SOL_FORMULA_VERSIONS.ROUTE_VALIDATION_RESULT_V1, 1.0, "high", { detail: "validation=passed" });
  if (outcome === "failed") return subscore("validation_result", SOL_FORMULA_VERSIONS.ROUTE_VALIDATION_RESULT_V1, 0.0, "high", { detail: "validation=failed" });
  return subscore("validation_result", SOL_FORMULA_VERSIONS.ROUTE_VALIDATION_RESULT_V1, 0.5, "medium", { detail: `validation=${outcome}` });
}

function scoreRouteConfirmedSignal(metrics: SolScorecardRawMetrics): SolSubscore {
  const status = metrics.router_child_status;
  const validation = metrics.router_child_validation;
  if (status === null || validation === null) {
    return skippedSubscore("confirmed_signal", SOL_FORMULA_VERSIONS.ROUTE_CONFIRMED_SIGNAL_V1, "no child outcome to confirm");
  }
  // A "confirmed" signal = selected route led to done+passed.
  // A "contradicted" signal = selected route exists but child failed/blocked.
  const confirmed = status === "done" && validation === "passed";
  const contradicted = status === "blocked" || validation === "failed";
  if (confirmed) {
    return subscore("confirmed_signal", SOL_FORMULA_VERSIONS.ROUTE_CONFIRMED_SIGNAL_V1, 1.0, "high", { detail: "outcome confirmed: done+passed" });
  }
  if (contradicted) {
    return subscore("confirmed_signal", SOL_FORMULA_VERSIONS.ROUTE_CONFIRMED_SIGNAL_V1, 0.0, "high", { detail: "outcome contradicted" });
  }
  return subscore("confirmed_signal", SOL_FORMULA_VERSIONS.ROUTE_CONFIRMED_SIGNAL_V1, 0.5, "medium", { detail: "outcome inconclusive" });
}

/**
 * Compute a scorecard for one routing decision.
 */
export function computeRoutingScorecard(
  ev: SolEvidence,
  decision: SolRouterDecisionEvidence,
  sourceRefs?: SolSourceRef[],
  groupingKeys?: SolGroupingKeys,
): SolScorecard {
  const rawMetrics = buildRoutingRawMetrics(ev, decision);
  const subscores: SolSubscore[] = [
    scoreRouteSelected(rawMetrics),
    scoreRouteCandidates(rawMetrics),
    scoreRouteFallbackPath(rawMetrics),
    scoreRouteOutcomeQuality(rawMetrics),
    scoreRouteTokenBurn(rawMetrics),
    scoreRouteQcResult(rawMetrics),
    scoreRouteValidationResult(rawMetrics),
    scoreRouteConfirmedSignal(rawMetrics),
  ];

  const key = decision.child_id || `${decision.selected_provider ?? "unknown"}-${decision.providers_tried.join(",")}`;
  return buildScorecard("routing", key, ev, rawMetrics, subscores, sourceRefs ?? buildDefaultEvidenceSourceRefs(ev), groupingKeys);
}

// ──────────────────────────────────────────────
// Batch calculators
// ──────────────────────────────────────────────

export interface SolScorecardSet {
  foreman: SolScorecard;
  workers: SolScorecard[];
  providers: SolScorecard[];
  models: SolScorecard[];
  routing: SolScorecard[];
}

/**
 * Compute the full set of scorecards for a run.
 */
export function computeAllScorecards(
  ev: SolEvidence,
  sourceRefs?: SolSourceRef[],
): SolScorecardSet {
  const refs = sourceRefs ?? buildDefaultEvidenceSourceRefs(ev);

  const foreman = computeForemanScorecard(ev, refs);

  const workers = ev.children
    .map((c) => computeWorkerScorecard(ev, c.child_id, refs))
    .filter((s): s is SolScorecard => s !== null);

  const providers = Array.from(new Set(ev.children.map((c) => c.provider).filter((p) => p)))
    .map((provider) => computeProviderScorecard(ev, provider, refs));

  const models = Array.from(new Set(ev.children.map((c) => c.grouping_keys.model).filter((m): m is string => !!m)))
    .map((model) => computeModelScorecard(ev, model, refs));

  const routing =
    ev.router.availability === "available"
      ? ev.router.decisions.map((d) => computeRoutingScorecard(ev, d, refs))
      : [];

  return { foreman, workers, providers, models, routing };
}
