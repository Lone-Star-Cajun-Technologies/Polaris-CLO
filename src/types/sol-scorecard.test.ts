/**
 * Tests for SOL scorecard schema contracts (sol-scorecard.ts) and metric
 * event contracts (sol-metrics.ts).
 *
 * Coverage:
 *   - buildRecommendationInputs: below_threshold, low-scoring, skipped, flags
 *   - computeAggregateScore: mean of non-null subscores, null when all skipped
 *   - determineScorecardAvailability: complete/partial/skipped/unavailable
 *   - SolScorecard shape: required fields present, source_refs, window
 *   - Formula version constants: stable string values
 *   - summarizeMetricEvents: counts all six categories correctly
 *   - Type guards: narrow correctly on category discriminant
 *   - Compatibility: SolEvidence types remain importable alongside scorecard types
 */

import { describe, expect, it } from "vitest";
import {
  buildRecommendationInputs,
  computeAggregateScore,
  determineScorecardAvailability,
  SOL_FORMULA_VERSIONS,
  FOREMAN_TOKEN_EFFICIENCY_SPEC,
  WORKER_TOKEN_EFFICIENCY_SPEC,
  FOREMAN_QUALITY_PER_TOKEN_SPEC,
  WORKER_QUALITY_PER_TOKEN_SPEC,
} from "./sol-scorecard.js";
import type {
  SolScorecard,
  SolSubscore,
  SolScorecardRawMetrics,
  SolSourceRef,
  SolScorecardWindow,
} from "./sol-scorecard.js";
import {
  summarizeMetricEvents,
  isProviderStartupFailure,
  isRouterFallback,
  isWorkerExecutionFailure,
  isValidationFailure,
  isQcFinding,
  isIntervention,
} from "./sol-metrics.js";
import type {
  SolMetricEvent,
  SolProviderStartupFailureEvent,
  SolRouterFallbackEvent,
  SolWorkerExecutionFailureEvent,
  SolValidationFailureEvent,
  SolQcFindingEvent,
  SolInterventionEvent,
} from "./sol-metrics.js";
// Verify existing types are importable alongside new types (compatibility)
import type { SolEvidence } from "./sol-evidence.js";
import type { SolScoreReport } from "./sol-score.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function scored(dimension: string, score: number): SolSubscore {
  return {
    dimension,
    formula_version: SOL_FORMULA_VERSIONS.COMPOSITE_MEAN_V1,
    score,
    confidence: "high",
  };
}

function skippedSubscore(dimension: string, reason: string): SolSubscore {
  return {
    dimension,
    formula_version: SOL_FORMULA_VERSIONS.COMPOSITE_MEAN_V1,
    score: null,
    confidence: "none",
    skipped_reason: reason,
  };
}

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

// ── computeAggregateScore ─────────────────────────────────────────────────────

describe("computeAggregateScore", () => {
  it("returns null when subscores list is empty", () => {
    expect(computeAggregateScore([])).toBeNull();
  });

  it("returns null when all subscores are skipped (score=null)", () => {
    const subscores = [
      skippedSubscore("token", "no evidence"),
      skippedSubscore("validation", "no evidence"),
    ];
    expect(computeAggregateScore(subscores)).toBeNull();
  });

  it("returns single score when only one subscore is non-null", () => {
    const subscores = [scored("token", 0.8), skippedSubscore("validation", "no evidence")];
    expect(computeAggregateScore(subscores)).toBe(0.8);
  });

  it("returns mean of non-null subscores", () => {
    const subscores = [scored("token", 0.8), scored("validation", 0.6)];
    expect(computeAggregateScore(subscores)).toBeCloseTo(0.7, 4);
  });

  it("ignores null (skipped) subscores in mean calculation", () => {
    const subscores = [
      scored("token", 1.0),
      skippedSubscore("qc", "future"),
      scored("validation", 0.0),
    ];
    // mean(1.0, 0.0) = 0.5, qc is excluded
    expect(computeAggregateScore(subscores)).toBeCloseTo(0.5, 4);
  });

  it("rounds to 4 decimal places", () => {
    const subscores = [scored("a", 1.0), scored("b", 1.0), scored("c", 0.5)];
    const result = computeAggregateScore(subscores);
    expect(result).not.toBeNull();
    expect(result!.toString()).toMatch(/^\d+\.\d{1,4}$/);
  });
});

// ── determineScorecardAvailability ───────────────────────────────────────────

describe("determineScorecardAvailability", () => {
  it("returns unavailable when subscores is empty", () => {
    expect(determineScorecardAvailability([])).toBe("unavailable");
  });

  it("returns skipped when all subscores are null", () => {
    const subscores = [
      skippedSubscore("token", "no evidence"),
      skippedSubscore("validation", "no evidence"),
    ];
    expect(determineScorecardAvailability(subscores)).toBe("skipped");
  });

  it("returns partial when some subscores are null", () => {
    const subscores = [scored("token", 0.8), skippedSubscore("validation", "no evidence")];
    expect(determineScorecardAvailability(subscores)).toBe("partial");
  });

  it("returns complete when all subscores are non-null", () => {
    const subscores = [scored("token", 0.8), scored("validation", 1.0)];
    expect(determineScorecardAvailability(subscores)).toBe("complete");
  });
});

// ── buildRecommendationInputs ─────────────────────────────────────────────────

describe("buildRecommendationInputs", () => {
  it("below_threshold=false when aggregate_score >= 0.6", () => {
    const inputs = buildRecommendationInputs([], emptyRawMetrics(), 0.75);
    expect(inputs.below_threshold).toBe(false);
  });

  it("below_threshold=true when aggregate_score < 0.6", () => {
    const inputs = buildRecommendationInputs([], emptyRawMetrics(), 0.5);
    expect(inputs.below_threshold).toBe(true);
  });

  it("below_threshold=false when aggregate_score is null", () => {
    const inputs = buildRecommendationInputs([], emptyRawMetrics(), null);
    expect(inputs.below_threshold).toBe(false);
  });

  it("identifies low-scoring dimensions (score < 0.5)", () => {
    const subscores = [scored("token", 0.3), scored("validation", 0.9)];
    const inputs = buildRecommendationInputs(subscores, emptyRawMetrics(), 0.6);
    expect(inputs.low_scoring_dimensions).toContain("token");
    expect(inputs.low_scoring_dimensions).not.toContain("validation");
  });

  it("identifies skipped dimensions", () => {
    const subscores = [skippedSubscore("qc", "future"), scored("token", 1.0)];
    const inputs = buildRecommendationInputs(subscores, emptyRawMetrics(), 1.0);
    expect(inputs.skipped_dimensions).toContain("qc");
    expect(inputs.skipped_dimensions).not.toContain("token");
  });

  it("over_token_budget=true when Foreman bootstrap tokens > 150k", () => {
    const metrics = { ...emptyRawMetrics(), max_bootstrap_tokens: 200_000 };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.over_token_budget).toBe(true);
  });

  it("over_token_budget=true when Worker tokens > 200k", () => {
    const metrics = { ...emptyRawMetrics(), worker_tokens_used: 250_000 };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.over_token_budget).toBe(true);
  });

  it("over_token_budget=false when tokens are within budget", () => {
    const metrics = { ...emptyRawMetrics(), max_bootstrap_tokens: 100_000, worker_tokens_used: 150_000 };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.over_token_budget).toBe(false);
  });

  it("intervention_detected=true when user_intervened=true", () => {
    const metrics = { ...emptyRawMetrics(), user_intervened: true };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.intervention_detected).toBe(true);
  });

  it("intervention_detected=true when foreman_intervened=true", () => {
    const metrics = { ...emptyRawMetrics(), foreman_intervened: true };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.intervention_detected).toBe(true);
  });

  it("intervention_detected=false when both flags are false", () => {
    const metrics = { ...emptyRawMetrics(), user_intervened: false, foreman_intervened: false };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.intervention_detected).toBe(false);
  });

  it("router_issue_detected=true when router_fallback_used=true", () => {
    const metrics = { ...emptyRawMetrics(), router_fallback_used: true };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.router_issue_detected).toBe(true);
  });

  it("router_issue_detected=true when router_exhausted=true", () => {
    const metrics = { ...emptyRawMetrics(), router_exhausted: true };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.router_issue_detected).toBe(true);
  });

  it("qc_issue_detected=true when qc_blocking_findings > 0", () => {
    const metrics = { ...emptyRawMetrics(), qc_blocking_findings: 2 };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.qc_issue_detected).toBe(true);
  });

  it("qc_issue_detected=true when qc_repair_loop_status=all-providers-failed", () => {
    const metrics = { ...emptyRawMetrics(), qc_repair_loop_status: "all-providers-failed" };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.qc_issue_detected).toBe(true);
  });

  it("qc_issue_detected=false when no QC issues", () => {
    const metrics = { ...emptyRawMetrics(), qc_blocking_findings: 0, qc_repair_loop_status: "passed" };
    const inputs = buildRecommendationInputs([], metrics, 1.0);
    expect(inputs.qc_issue_detected).toBe(false);
  });
});

// ── Formula version constants ─────────────────────────────────────────────────

describe("SOL_FORMULA_VERSIONS", () => {
  it("TOKEN_EFFICIENCY_V1 is stable string", () => {
    expect(SOL_FORMULA_VERSIONS.TOKEN_EFFICIENCY_V1).toBe("token-efficiency/1.0");
  });

  it("QUALITY_PER_TOKEN_V1 is stable string", () => {
    expect(SOL_FORMULA_VERSIONS.QUALITY_PER_TOKEN_V1).toBe("quality-per-token/1.0");
  });

  it("COMPOSITE_MEAN_V1 is stable string", () => {
    expect(SOL_FORMULA_VERSIONS.COMPOSITE_MEAN_V1).toBe("composite-mean/1.0");
  });

  it("VALIDATION_BINARY_V1 is stable string", () => {
    expect(SOL_FORMULA_VERSIONS.VALIDATION_BINARY_V1).toBe("validation-binary/1.0");
  });
});

describe("formula spec constants", () => {
  it("FOREMAN_TOKEN_EFFICIENCY_SPEC has correct budget and max_penalized", () => {
    expect(FOREMAN_TOKEN_EFFICIENCY_SPEC.formula_version).toBe("token-efficiency/1.0");
    expect(FOREMAN_TOKEN_EFFICIENCY_SPEC.budget).toBe(150_000);
    expect(FOREMAN_TOKEN_EFFICIENCY_SPEC.max_penalized).toBe(300_000);
    expect(FOREMAN_TOKEN_EFFICIENCY_SPEC.source_event_type).toBe("bootstrap-context-size");
  });

  it("WORKER_TOKEN_EFFICIENCY_SPEC has correct budget and max_penalized", () => {
    expect(WORKER_TOKEN_EFFICIENCY_SPEC.formula_version).toBe("token-efficiency/1.0");
    expect(WORKER_TOKEN_EFFICIENCY_SPEC.budget).toBe(200_000);
    expect(WORKER_TOKEN_EFFICIENCY_SPEC.max_penalized).toBe(500_000);
    expect(WORKER_TOKEN_EFFICIENCY_SPEC.source_event_type).toBe("worker-heartbeat-tokens");
  });

  it("FOREMAN_QUALITY_PER_TOKEN_SPEC has correct denominator and subject", () => {
    expect(FOREMAN_QUALITY_PER_TOKEN_SPEC.formula_version).toBe("quality-per-token/1.0");
    expect(FOREMAN_QUALITY_PER_TOKEN_SPEC.budget_denominator).toBe(150_000);
    expect(FOREMAN_QUALITY_PER_TOKEN_SPEC.subject).toBe("foreman");
  });

  it("WORKER_QUALITY_PER_TOKEN_SPEC has correct denominator and subject", () => {
    expect(WORKER_QUALITY_PER_TOKEN_SPEC.formula_version).toBe("quality-per-token/1.0");
    expect(WORKER_QUALITY_PER_TOKEN_SPEC.budget_denominator).toBe(200_000);
    expect(WORKER_QUALITY_PER_TOKEN_SPEC.subject).toBe("worker");
  });
});

// ── SolScorecard shape ────────────────────────────────────────────────────────

describe("SolScorecard shape", () => {
  it("can construct a valid SolScorecard object", () => {
    const window: SolScorecardWindow = { run_id: "run-001", cluster_id: "POL-000" };
    const sourceRef: SolSourceRef = {
      kind: "run-state",
      path: ".taskchain_artifacts/polaris-run/current-state.json",
      available: true,
    };
    const subscores: SolSubscore[] = [
      scored("token", 1.0),
      skippedSubscore("qc", "QC evidence availability=future"),
    ];
    const rawMetrics = emptyRawMetrics();
    const aggregateScore = computeAggregateScore(subscores);
    const availability = determineScorecardAvailability(subscores);
    const recommendationInputs = buildRecommendationInputs(subscores, rawMetrics, aggregateScore);

    const scorecard: SolScorecard = {
      schema_version: "1.0",
      scorecard_id: "foreman-run-001",
      subject: "foreman",
      subject_key: "run-001",
      window,
      grouping_keys: { provider: "devin" },
      generated_at: new Date().toISOString(),
      availability,
      raw_metrics: rawMetrics,
      subscores,
      aggregate_score: aggregateScore,
      aggregate_confidence: "high",
      source_refs: [sourceRef],
      recommendation_inputs: recommendationInputs,
      aggregate_formula_version: SOL_FORMULA_VERSIONS.COMPOSITE_MEAN_V1,
    };

    expect(scorecard.schema_version).toBe("1.0");
    expect(scorecard.subject).toBe("foreman");
    expect(scorecard.availability).toBe("partial");
    expect(scorecard.aggregate_score).toBe(1.0);
    expect(scorecard.source_refs).toHaveLength(1);
    expect(scorecard.subscores).toHaveLength(2);
  });

  it("SolScorecard with all-skipped subscores has availability=skipped and aggregate_score=null", () => {
    const subscores = [skippedSubscore("a", "no ev"), skippedSubscore("b", "no ev")];
    const agg = computeAggregateScore(subscores);
    const avail = determineScorecardAvailability(subscores);
    expect(agg).toBeNull();
    expect(avail).toBe("skipped");
  });

  it("SolSourceRef with available=false carries unavailable_reason", () => {
    const ref: SolSourceRef = {
      kind: "telemetry",
      path: ".taskchain_artifacts/polaris-run/runs/r1/telemetry.jsonl",
      available: false,
      unavailable_reason: "file not found",
    };
    expect(ref.available).toBe(false);
    expect(ref.unavailable_reason).toBe("file not found");
  });
});

// ── summarizeMetricEvents ─────────────────────────────────────────────────────

describe("summarizeMetricEvents", () => {
  it("returns all-zero summary for empty event list", () => {
    const summary = summarizeMetricEvents([]);
    expect(summary.provider_startup_failures).toBe(0);
    expect(summary.router_fallbacks).toBe(0);
    expect(summary.worker_execution_failures).toBe(0);
    expect(summary.validation_failures).toBe(0);
    expect(summary.qc_findings_total).toBe(0);
    expect(summary.user_interventions).toBe(0);
    expect(summary.foreman_interventions).toBe(0);
  });

  it("counts provider startup failures", () => {
    const event: SolProviderStartupFailureEvent = {
      category: "provider-startup-failure",
      run_id: "r1",
      provider: "devin",
      failure_reason: "timeout",
      providers_tried: ["devin"],
      all_providers_exhausted: true,
    };
    const summary = summarizeMetricEvents([event]);
    expect(summary.provider_startup_failures).toBe(1);
  });

  it("counts router fallbacks and successes", () => {
    const successful: SolRouterFallbackEvent = {
      category: "router-fallback",
      run_id: "r1",
      original_provider: "devin",
      fallback_provider: "claude",
      providers_tried: ["devin", "claude"],
      fallback_succeeded: true,
      rejection_reasons: ["over-capacity"],
    };
    const failed: SolRouterFallbackEvent = {
      category: "router-fallback",
      run_id: "r1",
      original_provider: "claude",
      fallback_provider: null,
      providers_tried: ["claude"],
      fallback_succeeded: false,
      rejection_reasons: [],
    };
    const summary = summarizeMetricEvents([successful, failed]);
    expect(summary.router_fallbacks).toBe(2);
    expect(summary.router_fallback_successes).toBe(1);
  });

  it("counts worker execution failures", () => {
    const event: SolWorkerExecutionFailureEvent = {
      category: "worker-execution-failure",
      run_id: "r1",
      child_id: "POL-001",
      worker_status: "failed",
      validation: "failed",
      provider: "devin",
      error_message: "build error",
      out_of_scope_escalation: false,
      escalation_count: 0,
    };
    const summary = summarizeMetricEvents([event]);
    expect(summary.worker_execution_failures).toBe(1);
  });

  it("counts validation failures", () => {
    const event: SolValidationFailureEvent = {
      category: "validation-failure",
      run_id: "r1",
      child_id: "POL-002",
      worker_status: "done",
      failed_commands: ["npm test"],
      passed_commands: ["npm run build"],
      error_message: "tests failed",
    };
    const summary = summarizeMetricEvents([event]);
    expect(summary.validation_failures).toBe(1);
  });

  it("counts QC findings with blocking and unvalidated flags", () => {
    const blocking: SolQcFindingEvent = {
      category: "qc-finding",
      run_id: "r1",
      qc_provider: "eslint",
      severity: "high",
      blocking: true,
      autofixed: false,
      repaired: false,
      waived: false,
      unvalidated: false,
      summary: "unused variable",
      attribution_confidence: "high",
    };
    const noisy: SolQcFindingEvent = {
      category: "qc-finding",
      run_id: "r1",
      qc_provider: "lint-noisy",
      severity: "info",
      blocking: false,
      autofixed: false,
      repaired: false,
      waived: false,
      unvalidated: true,
      summary: null,
      attribution_confidence: "none",
    };
    const summary = summarizeMetricEvents([blocking, noisy]);
    expect(summary.qc_findings_total).toBe(2);
    expect(summary.qc_findings_blocking).toBe(1);
    expect(summary.qc_findings_unvalidated).toBe(1);
  });

  it("counts user and foreman interventions separately", () => {
    const userEvent: SolInterventionEvent = {
      category: "user-intervention",
      run_id: "r1",
      actor: "user",
      intervention_type: "commit",
      resolved: true,
    };
    const foremanEvent: SolInterventionEvent = {
      category: "foreman-intervention",
      run_id: "r1",
      actor: "foreman",
      intervention_type: "state-repair",
      resolved: false,
    };
    const summary = summarizeMetricEvents([userEvent, foremanEvent]);
    expect(summary.user_interventions).toBe(1);
    expect(summary.foreman_interventions).toBe(1);
  });
});

// ── Type guards ───────────────────────────────────────────────────────────────

describe("SolMetricEvent type guards", () => {
  it("isProviderStartupFailure narrows correctly", () => {
    const e: SolMetricEvent = {
      category: "provider-startup-failure",
      run_id: "r1",
      provider: "devin",
      failure_reason: null,
      providers_tried: [],
      all_providers_exhausted: false,
    };
    expect(isProviderStartupFailure(e)).toBe(true);
    expect(isRouterFallback(e)).toBe(false);
  });

  it("isRouterFallback narrows correctly", () => {
    const e: SolMetricEvent = {
      category: "router-fallback",
      run_id: "r1",
      original_provider: "devin",
      fallback_provider: "claude",
      providers_tried: ["devin", "claude"],
      fallback_succeeded: true,
      rejection_reasons: [],
    };
    expect(isRouterFallback(e)).toBe(true);
    expect(isWorkerExecutionFailure(e)).toBe(false);
  });

  it("isWorkerExecutionFailure narrows correctly", () => {
    const e: SolMetricEvent = {
      category: "worker-execution-failure",
      run_id: "r1",
      worker_status: "failed",
      validation: "failed",
      provider: "devin",
      error_message: null,
      out_of_scope_escalation: false,
      escalation_count: 0,
    };
    expect(isWorkerExecutionFailure(e)).toBe(true);
    expect(isValidationFailure(e)).toBe(false);
  });

  it("isValidationFailure narrows correctly", () => {
    const e: SolMetricEvent = {
      category: "validation-failure",
      run_id: "r1",
      worker_status: "done",
      failed_commands: [],
      passed_commands: [],
      error_message: null,
    };
    expect(isValidationFailure(e)).toBe(true);
    expect(isQcFinding(e)).toBe(false);
  });

  it("isQcFinding narrows correctly", () => {
    const e: SolMetricEvent = {
      category: "qc-finding",
      run_id: "r1",
      qc_provider: "eslint",
      severity: "medium",
      blocking: false,
      autofixed: false,
      repaired: false,
      waived: false,
      unvalidated: false,
      summary: null,
      attribution_confidence: "medium",
    };
    expect(isQcFinding(e)).toBe(true);
    expect(isIntervention(e)).toBe(false);
  });

  it("isIntervention narrows correctly for user-intervention", () => {
    const e: SolMetricEvent = {
      category: "user-intervention",
      run_id: "r1",
      actor: "user",
      intervention_type: "commit",
      resolved: true,
    };
    expect(isIntervention(e)).toBe(true);
    expect(isProviderStartupFailure(e)).toBe(false);
  });

  it("isIntervention narrows correctly for foreman-intervention", () => {
    const e: SolMetricEvent = {
      category: "foreman-intervention",
      run_id: "r1",
      actor: "foreman",
      intervention_type: "out-of-scope",
      resolved: false,
    };
    expect(isIntervention(e)).toBe(true);
  });
});

// ── Compatibility: existing types remain importable ───────────────────────────

describe("backward compatibility: SolEvidence and SolScoreReport importable alongside new types", () => {
  it("SolEvidence type reference compiles without error", () => {
    // If this test file compiles, the import is compatible.
    const _ref: SolEvidence | null = null;
    expect(_ref).toBeNull();
  });

  it("SolScoreReport type reference compiles without error", () => {
    const _ref: SolScoreReport | null = null;
    expect(_ref).toBeNull();
  });
});
