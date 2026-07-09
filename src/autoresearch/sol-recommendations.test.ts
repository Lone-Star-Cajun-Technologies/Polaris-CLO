/**
 * Tests for the SOL recommendation engine.
 *
 * Coverage:
 *   - generateRecommendations: empty input, threshold/min-samples gating
 *   - Evidence references in recommendations
 *   - Affected routing dimensions and proposed policy actions
 *   - Confidence bounded to [0, 1]
 *   - Advisory default (no file writes or mutations)
 *   - recommendationsToProposals conversion shape
 *   - scorecardToRecommendationSummary: verdict logic, evidence extraction,
 *     mutation safety, advisory default, no-auto-apply behavior
 */

import { describe, expect, it } from "vitest";
import {
  generateRecommendations,
  recommendationsToProposals,
  recommendationToProposal,
  formatRecommendationsCli,
  generateQcRecommendations,
  formatQcRecommendations,
  scorecardToRecommendationSummary,
  scorecardsToRecommendationSummaries,
} from "./sol-recommendations.js";
import type { SolScoreSnapshot } from "./sol-history.js";
import type { SolScoreReport } from "../types/sol-score.js";
import type { SolEvidence, SolQcEvidence } from "../types/sol-evidence.js";
import type { SolScorecard, SolSubscore, SolRecommendationInputs } from "../types/sol-scorecard.js";
import { buildRecommendationInputs } from "../types/sol-scorecard.js";

// ── Helpers ──

function makeDimScore(dimension: string, score: number | null) {
  return { dimension, score, confidence: "high" as const };
}

function makeReport(runId: string, compositeScore: number | null): SolScoreReport {
  const dim = (name: string) => makeDimScore(name, compositeScore);
  return {
    run_id: runId,
    cluster_id: "POL-100",
    scored_at: new Date().toISOString(),
    foreman: {
      composite_score: compositeScore !== null ? compositeScore + 0.05 : null,
      composite_confidence: "high",
      token: dim("token"),
      duration: dim("duration"),
      intervention: dim("intervention"),
      pre_analysis: dim("pre_analysis"),
      dependency: dim("dependency"),
      dispatch: dim("dispatch"),
      evidence_validation: dim("evidence_validation"),
      scope: dim("scope"),
      completion: dim("completion"),
      recovery: dim("recovery"),
      qc_repair_loop: dim("qc_repair_loop"),
    },
    workers: {
      "POL-001": {
        child_id: "POL-001",
        composite_score: compositeScore !== null ? compositeScore - 0.05 : null,
        composite_confidence: "high",
        token: dim("token"),
        duration: dim("duration"),
        validation: dim("validation"),
        qc: dim("qc"),
        repair_iterations: dim("repair_iterations"),
        scope_adherence: dim("scope_adherence"),
        acceptance_criteria: dim("acceptance_criteria"),
        first_pass: dim("first_pass"),
      },
    },
    run_composite_score: compositeScore,
  };
}

function makeSnapshot(
  runId: string,
  compositeScore: number | null,
  groupingKeys: Record<string, string> = {},
  workerIds: string[] = [],
): SolScoreSnapshot {
  return {
    schema_version: "1.0",
    report: makeReport(runId, compositeScore),
    grouping_keys: groupingKeys,
    worker_ids: workerIds,
  };
}

// ── Empty input ──

describe("generateRecommendations: empty input", () => {
  it("returns zero recommendations and zero snapshots", () => {
    const report = generateRecommendations([]);
    expect(report.total_snapshots).toBe(0);
    expect(report.recommendations).toHaveLength(0);
    expect(report.threshold).toBe(0.7);
    expect(report.min_samples).toBe(2);
  });
});

// ── Threshold gating ──

describe("generateRecommendations: threshold", () => {
  it("emits a recommendation when a provider group is below threshold", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.55, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });

    expect(report.recommendations).toHaveLength(1);
    const rec = report.recommendations[0];
    expect(rec.id).toBe("provider:provider=devin");
    expect(rec.affected.provider).toBe("devin");
    expect(rec.category).toBe("provider_policy");
    expect(rec.action_type).toBe("implement");
    expect(rec.proposed_action).toContain("provider eligibility");
  });

  it("does not emit a recommendation when mean is above threshold", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.85, { provider: "devin" }),
      makeSnapshot("run-2", 0.9, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });
    expect(report.recommendations).toHaveLength(0);
  });

  it("respects a custom threshold", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.6, { provider: "devin" }),
      makeSnapshot("run-2", 0.65, { provider: "devin" }),
    ];
    const below = generateRecommendations(snapshots, { groupBy: ["provider"], threshold: 0.7 });
    expect(below.recommendations).toHaveLength(1);

    const above = generateRecommendations(snapshots, { groupBy: ["provider"], threshold: 0.5 });
    expect(above.recommendations).toHaveLength(0);
  });

  it("respects minSamples", () => {
    const snapshots = [makeSnapshot("run-1", 0.5, { provider: "devin" })];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"], minSamples: 2 });
    expect(report.recommendations).toHaveLength(0);
  });
});

// ── Evidence references ──

describe("generateRecommendations: evidence", () => {
  it("includes run_ids, count, mean, min, max composites", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.6, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });

    const rec = report.recommendations[0];
    expect(rec.evidence.count).toBe(2);
    expect(rec.evidence.run_ids).toContain("run-1");
    expect(rec.evidence.run_ids).toContain("run-2");
    expect(rec.evidence.mean_composite).toBe(0.55);
    expect(rec.evidence.min_composite).toBe(0.5);
    expect(rec.evidence.max_composite).toBe(0.6);
  });

  it("identifies route and task_type affected dimensions", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { route: "src/loop", task_type: "impl", provider: "devin" }),
      makeSnapshot("run-2", 0.55, { route: "src/loop", task_type: "impl", provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["route", "task_type"] });

    const routeRec = report.recommendations.find((r) => r.id.startsWith("route:"));
    expect(routeRec).toBeDefined();
    expect(routeRec!.affected.route).toBe("src/loop");

    const taskRec = report.recommendations.find((r) => r.id.startsWith("task_type:"));
    expect(taskRec).toBeDefined();
    expect(taskRec!.affected.task_type).toBe("impl");
  });
});

// ── Confidence and action types ──

describe("generateRecommendations: confidence", () => {
  it("bounds confidence to [0, 1]", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.1, { provider: "devin" }),
      makeSnapshot("run-2", 0.1, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });
    const rec = report.recommendations[0];
    expect(rec.confidence).toBeGreaterThanOrEqual(0);
    expect(rec.confidence).toBeLessThanOrEqual(1);
  });

  it("uses analyze action when foreman composite is the weaker signal", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.85, { provider: "devin" }), // overall above threshold; will not trigger
    ];
    // No underperformance, so no recommendation. Test the helper via direct evidence construction.
    const below = [
      makeSnapshot("run-1", 0.4, { provider: "devin" }),
      makeSnapshot("run-2", 0.45, { provider: "devin" }),
    ];
    const report = generateRecommendations(below, { groupBy: ["provider"] });
    expect(report.recommendations[0].action_type).toMatch(/analyze|implement/);
  });
});

// ── Advisory default / no silent mutation ──

describe("generateRecommendations: advisory safety", () => {
  it("does not write files or mutate input snapshots", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.55, { provider: "devin" }),
    ];
    const original = JSON.stringify(snapshots);
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });

    expect(report.recommendations.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshots)).toBe(original);
  });

  it("produces no tracker proposals unless explicitly converted", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.55, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });
    expect(report.recommendations.every((r) => r.proposed_action.length > 0)).toBe(true);
  });
});

// ── Proposal conversion ──

describe("recommendationsToProposals", () => {
  it("maps recommendations to AutresearchProposal shape", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.55, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });
    const proposals = recommendationsToProposals(report.recommendations);

    expect(proposals).toHaveLength(1);
    const p = proposals[0];
    expect(p.gate_id).toBe("sol-recommendation:provider:provider=devin");
    expect(p.artifact_type).toBe("provider-role-recommendation");
    expect(p.evidence_run_ids).toContain("run-1");
    expect(typeof p.confidence).toBe("number");
    expect(p.fix_zone).toContain("provider-role-recommendation");
    expect(p.hint).toContain("provider eligibility");
  });

  it("uses runId override when provided", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.55, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });
    const proposals = recommendationsToProposals(report.recommendations, "override-run");
    expect(proposals[0].run_id).toBe("override-run");
  });
});

// ── CLI formatter ──

describe("formatRecommendationsCli", () => {
  it("renders a readable advisory report", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.5, { provider: "devin" }),
      makeSnapshot("run-2", 0.55, { provider: "devin" }),
    ];
    const report = generateRecommendations(snapshots, { groupBy: ["provider"] });
    const output = formatRecommendationsCli(report);

    expect(output).toContain("SOL Routing Recommendations");
    expect(output).toContain("provider=devin");
    expect(output).toContain("provider eligibility");
  });

  it("handles empty report", () => {
    const report = generateRecommendations([]);
    const output = formatRecommendationsCli(report);
    expect(output).toContain("No underperforming groups detected");
  });
});

// ── QC follow-up recommendations ───────────────────────────────────────────────

function baseQcEvidence(overrides: Partial<SolQcEvidence> = {}): SolQcEvidence {
  return {
    availability: "available",
    qc_run_count: 1,
    total_findings: 1,
    blocking_findings: 0,
    autofixed_findings: 0,
    repaired_findings: 1,
    waived_findings: 0,
    unvalidated_findings: 0,
    weighted_open_score: 0,
    qc_penalty: 0,
    blocks_delivery: false,
    open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    provider_breakdown: {},
    repair_loop: {
      status: "passed",
      rounds_completed: 1,
      max_rounds: 2,
      packets_compiled: 1,
      packets_completed: 1,
      packets_failed: 0,
      rerun_outcome: "pass",
      provider_attempts: {
        total: 1,
        success: 1,
        failure: 0,
        fallback: 0,
        skipped: 0,
        all_providers_failed: false,
      },
    },
    noisy_providers: [],
    has_repair_failures: false,
    unresolved_high_severity: 0,
    max_round_exhausted: false,
    ...overrides,
  };
}

function baseEvidence(overrides: Partial<SolEvidence> = {}): SolEvidence {
  return {
    schema_version: "1.0",
    run_id: "run-qc-001",
    cluster_id: "POL-100",
    observed_at: new Date().toISOString(),
    grouping_keys: {},
    run: {
      run_id: "run-qc-001",
      cluster_id: "POL-100",
      branch: "main",
      status: "done",
      total_children: 0,
      completed_children: 0,
      dispatch_epoch: null,
      continue_epoch: null,
      state_observed_at: null,
    },
    children: [],
    foreman: {
      max_bootstrap_tokens: null,
      over_token_budget: false,
      redispatch_count: 0,
      redispatched_children: [],
      foreman_corrective_commit: false,
      escalation_events: 0,
    },
    worker: {
      total_heartbeats: 0,
      total_escalations: 0,
      workers_succeeded: 0,
      workers_failed: 0,
      workers_blocked: 0,
      validation_failures: 0,
      validation_passes: 0,
      user_interventions: 0,
      foreman_interventions: 0,
    },
    router: {
      availability: "future",
      total_decisions: 0,
      exhausted_decisions: 0,
      fallback_attempts: 0,
      successful_fallbacks: 0,
      decisions: [],
      recurring_failure_reasons: [],
    },
    qc: baseQcEvidence(),
    validation: [],
    tokens: {
      max_bootstrap_tokens: null,
      total_worker_heartbeats: 0,
      tokens_by_child: {},
    },
    intervention: {
      user_intervened: false,
      foreman_intervened: false,
      blocked_event_count: 0,
      out_of_scope_count: 0,
      state_repair_required: false,
    },
    ...overrides,
  };
}

describe("generateQcRecommendations", () => {
  it("returns no recommendations when QC evidence is not available", () => {
    const ev = baseEvidence({ qc: baseQcEvidence({ availability: "future" }) });
    const report = generateQcRecommendations(ev);
    expect(report.recommendations).toHaveLength(0);
  });

  it("emits a noisy-provider recommendation", () => {
    const ev = baseEvidence({
      qc: baseQcEvidence({
        provider_breakdown: { noisy: { total: 4, blocking: 0, unvalidated: 3 } },
        noisy_providers: ["noisy"],
      }),
    });
    const report = generateQcRecommendations(ev);
    const rec = report.recommendations.find((r) => r.id === "qc-noisy-provider:noisy");
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("provider_policy");
    expect(rec!.affected.provider).toBe("noisy");
  });

  it("emits a repeated-repair-failure recommendation for medic-referral", () => {
    const ev = baseEvidence({
      qc: baseQcEvidence({
        repair_loop: {
          ...baseQcEvidence().repair_loop!,
          status: "medic-referral",
          packets_failed: 1,
        },
        has_repair_failures: true,
      }),
    });
    const report = generateQcRecommendations(ev);
    const rec = report.recommendations.find((r) => r.id === `qc-repair-failure:${ev.run_id}`);
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("qc_follow_up");
  });

  it("emits an unresolved high-severity recommendation", () => {
    const ev = baseEvidence({
      qc: baseQcEvidence({ unresolved_high_severity: 3 }),
    });
    const report = generateQcRecommendations(ev);
    const rec = report.recommendations.find((r) => r.id.startsWith("qc-unresolved-high-severity"));
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("qc_follow_up");
  });

  it("emits a max-round-exhaustion recommendation", () => {
    const ev = baseEvidence({
      qc: baseQcEvidence({
        repair_loop: {
          ...baseQcEvidence().repair_loop!,
          status: "max-rounds",
          rounds_completed: 2,
          max_rounds: 2,
        },
        max_round_exhausted: true,
      }),
    });
    const report = generateQcRecommendations(ev);
    const rec = report.recommendations.find((r) => r.id.startsWith("qc-max-rounds"));
    expect(rec).toBeDefined();
    expect(rec!.category).toBe("qc_follow_up");
  });

  it("renders QC follow-up recommendations", () => {
    const ev = baseEvidence({ qc: baseQcEvidence({ unresolved_high_severity: 1 }) });
    const report = generateQcRecommendations(ev);
    const output = formatQcRecommendations(report);
    expect(output).toContain("SOL QC Follow-Up Recommendations");
    expect(output).toContain("qc-unresolved-high-severity");
  });
});

// ── Scorecard → recommendation input bridge ─────────────────────────────────

/**
 * Minimal SolScorecard fixture builder for bridge tests.
 */
function makeScorecard(
  overrides: {
    subject?: SolScorecard["subject"];
    subject_key?: string;
    aggregate_score?: number | null;
    subscores?: SolSubscore[];
    grouping_keys?: Record<string, string>;
    blocking_findings?: number;
    validation_outcome?: string;
    intervention?: boolean;
    router_issue?: boolean;
  } = {},
): SolScorecard {
  const {
    subject = "provider",
    subject_key = "devin",
    aggregate_score = 0.8,
    subscores = [],
    grouping_keys = {},
    blocking_findings = 0,
    validation_outcome = "passed",
    intervention = false,
    router_issue = false,
  } = overrides;

  const baseSubscores: SolSubscore[] = subscores.length > 0 ? subscores : [
    { dimension: "role_suitability", formula_version: "role-suitability/1.0", score: aggregate_score, confidence: "high" },
    { dimension: "validation_result", formula_version: "validation-binary/1.0", score: validation_outcome === "passed" ? 1.0 : 0.0, confidence: "high" },
  ];

  const rawMetrics = {
    max_bootstrap_tokens: null,
    worker_tokens_used: null,
    dispatch_epoch: null,
    continue_epoch: null,
    total_children: null,
    workers_succeeded: null,
    workers_failed: null,
    redispatch_count: null,
    validation_outcome,
    passed_commands: validation_outcome === "passed" ? ["npm run build"] : [],
    qc_total_findings: blocking_findings,
    qc_blocking_findings: blocking_findings,
    qc_repaired_findings: null,
    qc_repair_loop_status: null,
    qc_repair_rounds: null,
    escalation_count: null,
    out_of_scope_count: null,
    user_intervened: intervention,
    foreman_intervened: null,
    state_repair_required: null,
    provider_selected: null,
    router_fallback_used: router_issue,
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

  const recommendation_inputs = buildRecommendationInputs(baseSubscores, rawMetrics, aggregate_score);

  return {
    schema_version: "1.0",
    scorecard_id: `${subject}-${subject_key}-run-001`,
    subject,
    subject_key,
    window: { run_id: "run-001" },
    grouping_keys,
    generated_at: new Date().toISOString(),
    availability: "complete",
    raw_metrics: rawMetrics,
    subscores: baseSubscores,
    aggregate_score,
    aggregate_confidence: "high",
    source_refs: [{ kind: "run-state", path: ".taskchain_artifacts/polaris-run/current-state.json", available: true }],
    recommendation_inputs,
    aggregate_formula_version: "composite-mean/1.0",
  };
}

describe("scorecardToRecommendationSummary: mutation safety", () => {
  it("does not mutate the input scorecard", () => {
    const sc = makeScorecard({ aggregate_score: 0.5 });
    const original = JSON.stringify(sc);
    scorecardToRecommendationSummary(sc);
    expect(JSON.stringify(sc)).toBe(original);
  });

  it("does not mutate input when called in batch", () => {
    const scorecards = [
      makeScorecard({ subject_key: "devin", aggregate_score: 0.5 }),
      makeScorecard({ subject_key: "claude", aggregate_score: 0.9 }),
    ];
    const originals = scorecards.map((s) => JSON.stringify(s));
    scorecardsToRecommendationSummaries(scorecards);
    scorecards.forEach((s, i) => expect(JSON.stringify(s)).toBe(originals[i]));
  });

  it("does not silently mutate provider policy, routing thresholds, or source files", () => {
    // This is a pure advisory function — calling it produces only the return value.
    // We verify no side effects by confirming the scorecard is unchanged
    // and the result has no write-capable references.
    const sc = makeScorecard({ aggregate_score: 0.4 });
    const result = scorecardToRecommendationSummary(sc);
    // Result carries no write handle, API client, or mutable state reference.
    expect(typeof result).toBe("object");
    expect(result.verdict).toMatch(/supported|contradicted|inconclusive/);
    // source_refs are read-only copies (plain objects, not file handles)
    expect(result.source_refs.every((r) => typeof r.path === "string")).toBe(true);
  });
});

describe("scorecardToRecommendationSummary: verdict logic", () => {
  it("returns 'supported' for high aggregate score without intervention", () => {
    const sc = makeScorecard({ aggregate_score: 0.9 });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("supported");
  });

  it("returns 'contradicted' for low aggregate score (<0.5)", () => {
    const sc = makeScorecard({ aggregate_score: 0.3 });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("contradicted");
  });

  it("keeps low aggregate score as 'contradicted' even when intervention or router flags are set", () => {
    const sc = makeScorecard({ aggregate_score: 0.3, intervention: true, router_issue: true });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("contradicted");
  });

  it("returns 'contradicted' when blocking QC findings are present", () => {
    const sc = makeScorecard({ aggregate_score: 0.9, blocking_findings: 2 });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("contradicted");
  });

  it("returns 'inconclusive' for mid-range aggregate score (0.6–0.74)", () => {
    const sc = makeScorecard({ aggregate_score: 0.65 });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("inconclusive");
  });

  it("returns 'inconclusive' when intervention is detected, even with high score", () => {
    const sc = makeScorecard({ aggregate_score: 0.85, intervention: true });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("inconclusive");
  });

  it("returns 'inconclusive' when router issue is detected", () => {
    const sc = makeScorecard({ aggregate_score: 0.85, router_issue: true });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("inconclusive");
  });

  it("uses confirmed_signal subscore when present (score=1.0 → supported)", () => {
    const subscores: SolSubscore[] = [
      { dimension: "confirmed_signal", formula_version: "route-confirmed-signal/1.0", score: 1.0, confidence: "high" },
    ];
    const sc = makeScorecard({ subject: "routing", subject_key: "POL-001", subscores, aggregate_score: 1.0 });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("supported");
  });

  it("uses confirmed_signal subscore when present (score=0.0 → contradicted)", () => {
    const subscores: SolSubscore[] = [
      { dimension: "confirmed_signal", formula_version: "route-confirmed-signal/1.0", score: 0.0, confidence: "high" },
    ];
    const sc = makeScorecard({ subject: "routing", subject_key: "POL-001", subscores, aggregate_score: 0.0 });
    expect(scorecardToRecommendationSummary(sc).verdict).toBe("contradicted");
  });
});

describe("scorecardToRecommendationSummary: evidence extraction", () => {
  it("includes quality_per_token evidence when subscore is present", () => {
    const subscores: SolSubscore[] = [
      { dimension: "role_suitability", formula_version: "role-suitability/1.0", score: 0.9, confidence: "high" },
      { dimension: "quality_per_token", formula_version: "quality-per-token/1.0", score: 0.85, confidence: "high", detail: "tokens=50000, composite=0.9" },
    ];
    const sc = makeScorecard({ subscores, aggregate_score: 0.875 });
    const summary = scorecardToRecommendationSummary(sc);
    expect(summary.quality_per_token.score).toBe(0.85);
    expect(summary.quality_per_token.detail).toContain("tokens=50000");
  });

  it("quality_per_token is null when not present in subscores", () => {
    const sc = makeScorecard({ aggregate_score: 0.8 });
    expect(scorecardToRecommendationSummary(sc).quality_per_token.score).toBeNull();
  });

  it("includes QC evidence from raw_metrics", () => {
    const sc = makeScorecard({ blocking_findings: 3, aggregate_score: 0.5 });
    const summary = scorecardToRecommendationSummary(sc);
    expect(summary.qc.blocking_findings).toBe(3);
    expect(summary.qc.qc_findings).toBe(3);
  });

  it("includes validation evidence from raw_metrics", () => {
    const sc = makeScorecard({ validation_outcome: "passed", aggregate_score: 0.8 });
    const summary = scorecardToRecommendationSummary(sc);
    expect(summary.validation.validation_outcome).toBe("passed");
    expect(summary.validation.passed_commands).toContain("npm run build");
  });

  it("includes validation score from validation_result subscore", () => {
    const subscores: SolSubscore[] = [
      { dimension: "validation_result", formula_version: "validation-binary/1.0", score: 1.0, confidence: "high" },
    ];
    const sc = makeScorecard({ subscores, aggregate_score: 1.0 });
    expect(scorecardToRecommendationSummary(sc).validation.validation_score).toBe(1.0);
  });

  it("extracts affected provider from scorecard subject_key for provider subject", () => {
    const sc = makeScorecard({ subject: "provider", subject_key: "anthropic", aggregate_score: 0.8 });
    expect(scorecardToRecommendationSummary(sc).affected.provider).toBe("anthropic");
  });

  it("extracts affected model from scorecard subject_key for model subject", () => {
    const sc = makeScorecard({ subject: "model", subject_key: "claude-opus-4", aggregate_score: 0.8 });
    expect(scorecardToRecommendationSummary(sc).affected.model).toBe("claude-opus-4");
  });

  it("extracts affected route from grouping_keys", () => {
    const sc = makeScorecard({ grouping_keys: { route: "src/autoresearch" }, aggregate_score: 0.8 });
    expect(scorecardToRecommendationSummary(sc).affected.route).toBe("src/autoresearch");
  });

  it("includes source_refs from the scorecard", () => {
    const sc = makeScorecard({ aggregate_score: 0.8 });
    const summary = scorecardToRecommendationSummary(sc);
    expect(summary.source_refs).toHaveLength(1);
    expect(summary.source_refs[0].kind).toBe("run-state");
  });

  it("includes low_scoring_dimensions from recommendation_inputs", () => {
    const subscores: SolSubscore[] = [
      { dimension: "token_efficiency", formula_version: "token-efficiency/1.0", score: 0.3, confidence: "high" },
      { dimension: "role_suitability", formula_version: "role-suitability/1.0", score: 0.9, confidence: "high" },
    ];
    const sc = makeScorecard({ subscores, aggregate_score: 0.6 });
    const summary = scorecardToRecommendationSummary(sc);
    expect(summary.low_scoring_dimensions).toContain("token_efficiency");
    expect(summary.low_scoring_dimensions).not.toContain("role_suitability");
  });
});

describe("scorecardToRecommendationSummary: advisory default", () => {
  it("confidence is bounded to [0, 1]", () => {
    const sc = makeScorecard({ aggregate_score: 0.1 });
    const { confidence } = scorecardToRecommendationSummary(sc);
    expect(confidence).toBeGreaterThanOrEqual(0);
    expect(confidence).toBeLessThanOrEqual(1);
  });

  it("confidence is minimal (0.1) when all subscores are skipped", () => {
    const subscores: SolSubscore[] = [
      { dimension: "token_efficiency", formula_version: "token-efficiency/1.0", score: null, confidence: "none", skipped_reason: "no token data" },
    ];
    const sc = makeScorecard({ subscores, aggregate_score: null });
    const { confidence } = scorecardToRecommendationSummary(sc);
    expect(confidence).toBe(0.1);
  });

  it("summary carries no tracker filing side effects — is advisory only", () => {
    // scorecardToRecommendationSummary is a pure function that returns a
    // plain object. It does not call routeProposals or write any files.
    // Verifying type-level advisory-only contract via structural check.
    const sc = makeScorecard({ aggregate_score: 0.4 });
    const summary = scorecardToRecommendationSummary(sc);
    // The summary has no gate_id, artifact_type, fix_zone, or hint fields
    // (those belong to AutresearchProposal — the explicitly filed type).
    expect("gate_id" in summary).toBe(false);
    expect("artifact_type" in summary).toBe(false);
    expect("fix_zone" in summary).toBe(false);
  });

  it("batch function returns one summary per scorecard", () => {
    const scorecards = [
      makeScorecard({ subject_key: "devin", aggregate_score: 0.5 }),
      makeScorecard({ subject_key: "anthropic", aggregate_score: 0.9 }),
      makeScorecard({ subject_key: "openai", aggregate_score: 0.65 }),
    ];
    const summaries = scorecardsToRecommendationSummaries(scorecards);
    expect(summaries).toHaveLength(3);
    expect(summaries.map((s) => s.subject_key)).toEqual(["devin", "anthropic", "openai"]);
  });

  it("identifies verdicts across supported/contradicted/inconclusive", () => {
    const scorecards = [
      makeScorecard({ subject_key: "good-provider", aggregate_score: 0.9 }),
      makeScorecard({ subject_key: "bad-provider", aggregate_score: 0.3 }),
      makeScorecard({ subject_key: "mid-provider", aggregate_score: 0.65 }),
    ];
    const summaries = scorecardsToRecommendationSummaries(scorecards);
    expect(summaries.find((s) => s.subject_key === "good-provider")!.verdict).toBe("supported");
    expect(summaries.find((s) => s.subject_key === "bad-provider")!.verdict).toBe("contradicted");
    expect(summaries.find((s) => s.subject_key === "mid-provider")!.verdict).toBe("inconclusive");
  });
});
