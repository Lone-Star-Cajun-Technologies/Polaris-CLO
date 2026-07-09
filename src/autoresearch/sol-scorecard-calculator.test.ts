/**
 * Tests for SOL scorecard calculator.
 *
 * Coverage:
 *   - Foreman scorecard: token, duration, intervention, dependency, dispatch,
 *     evidence validation, scope, completion, recovery, qc_repair_loop, quality_per_token
 *   - Worker scorecard: token, duration, validation, qc, repair_iterations,
 *     scope_adherence, acceptance_criteria, first_pass, quality_per_token
 *   - Provider scorecard: startup_failure, quota_exhaustion, fallback_frequency,
 *     role_suitability, runtime, token_efficiency, quality_outcomes
 *   - Model scorecard: same dimensions as provider, grouped by model
 *   - Routing scorecard: route_selected, candidates, fallback_path, outcome_quality,
 *     token_burn, qc_result, validation_result, confirmed_signal
 *   - computeAllScorecards: produces all subject scorecards
 */

import { describe, expect, it } from "vitest";
import {
  computeForemanScorecard,
  computeWorkerScorecard,
  computeProviderScorecard,
  computeModelScorecard,
  computeRoutingScorecard,
  computeAllScorecards,
  buildForemanRawMetrics,
  buildWorkerRawMetrics,
  buildProviderRawMetrics,
  buildModelRawMetrics,
  buildRoutingRawMetrics,
} from "./sol-scorecard-calculator.js";
import type { SolEvidence, SolRouterDecisionEvidence, SolQcEvidence } from "../types/sol-evidence.js";
import { SOL_FORMULA_VERSIONS } from "../types/sol-scorecard.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseEvidence(overrides: Partial<SolEvidence> = {}): SolEvidence {
  return {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-485",
    observed_at: new Date().toISOString(),
    grouping_keys: { repo: "Polaris", task_type: "implementation" },
    run: {
      run_id: "test-run-001",
      cluster_id: "POL-485",
      branch: "pol-485-sol-evaluation-reports",
      status: "running",
      total_children: 0,
      completed_children: 0,
      dispatch_epoch: 1,
      continue_epoch: 0,
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
    qc: {
      availability: "future",
      qc_run_count: 0,
      total_findings: 0,
      blocking_findings: 0,
      autofixed_findings: 0,
      repaired_findings: 0,
      waived_findings: 0,
      unvalidated_findings: 0,
      weighted_open_score: 0,
      qc_penalty: 0,
      blocks_delivery: false,
      open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      provider_breakdown: {},
      repair_loop: null,
      noisy_providers: [],
      has_repair_failures: false,
      unresolved_high_severity: 0,
      max_round_exhausted: false,
    },
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

function makeChild(overrides: Partial<SolEvidence["children"][number]> = {}): SolEvidence["children"][number] {
  return {
    child_id: "POL-001",
    run_id: "test-run-001",
    cluster_id: "POL-485",
    status: "done",
    validation: "passed",
    commit: "abc123",
    next_recommended_action: "continue",
    role: "worker",
    provider: "devin",
    skill_name: "polaris-run",
    packet_hash: "hash1",
    worker_id: "worker-001",
    escalation_count: 0,
    heartbeat_count: 5,
    user_intervened: false,
    foreman_intervened: false,
    changed_files: [],
    dispatch_epoch: 1,
    grouping_keys: { provider: "devin", model: "claude-3-7-sonnet" },
    ...overrides,
  };
}

function qcEvidence(overrides: Partial<SolQcEvidence> = {}): SolQcEvidence {
  return {
    availability: "available",
    qc_run_count: 1,
    total_findings: 0,
    blocking_findings: 0,
    autofixed_findings: 0,
    repaired_findings: 0,
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
      provider_attempts: { total: 1, success: 1, failure: 0, fallback: 0, skipped: 0, all_providers_failed: false },
    },
    noisy_providers: [],
    has_repair_failures: false,
    unresolved_high_severity: 0,
    max_round_exhausted: false,
    ...overrides,
  };
}

// ── Foreman scorecard ─────────────────────────────────────────────────────────

describe("computeForemanScorecard", () => {
  it("produces a scorecard with all required fields", () => {
    const scorecard = computeForemanScorecard(baseEvidence());
    expect(scorecard.schema_version).toBe("1.0");
    expect(scorecard.subject).toBe("foreman");
    expect(scorecard.subject_key).toBe("test-run-001");
    expect(scorecard.window.run_id).toBe("test-run-001");
    expect(scorecard.subscores.length).toBeGreaterThan(0);
    expect(scorecard.source_refs.length).toBeGreaterThan(0);
  });

  it("includes token usage subscore when bootstrap tokens are present", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 100_000 },
    });
    const scorecard = computeForemanScorecard(ev);
    const token = scorecard.subscores.find((s) => s.dimension === "token");
    expect(token?.score).toBe(1.0);
    expect(token?.confidence).toBe("high");
    expect(scorecard.raw_metrics.max_bootstrap_tokens).toBe(100_000);
  });

  it("skips dimensions when evidence is missing and includes reasons", () => {
    const scorecard = computeForemanScorecard(baseEvidence());
    const skipped = scorecard.subscores.filter((s) => s.score === null);
    expect(skipped.length).toBeGreaterThan(0);
    for (const s of skipped) {
      expect(s.skipped_reason).toBeTruthy();
      expect(s.confidence).toBe("none");
    }
  });

  it("includes intervention subscore with foreman/user intervention signals", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 1 },
      children: [makeChild()],
      intervention: { ...baseEvidence().intervention, foreman_intervened: true },
    });
    const scorecard = computeForemanScorecard(ev);
    const intervention = scorecard.subscores.find((s) => s.dimension === "intervention");
    expect(intervention?.score).toBe(0.5);
  });

  it("preserves raw metrics for dispatch and completion", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 3 },
      foreman: { ...baseEvidence().foreman, redispatch_count: 1 },
      worker: { ...baseEvidence().worker, workers_succeeded: 2, workers_failed: 1 },
    });
    const scorecard = computeForemanScorecard(ev);
    expect(scorecard.raw_metrics.total_children).toBe(3);
    expect(scorecard.raw_metrics.redispatch_count).toBe(1);
    expect(scorecard.raw_metrics.workers_succeeded).toBe(2);
    expect(scorecard.raw_metrics.workers_failed).toBe(1);
  });

  it("includes qc_repair_loop subscore when QC evidence is available", () => {
    const ev = baseEvidence({ qc: qcEvidence() });
    const scorecard = computeForemanScorecard(ev);
    const qc = scorecard.subscores.find((s) => s.dimension === "qc_repair_loop");
    expect(qc?.score).toBe(1.0);
    expect(qc?.formula_version).toBe(SOL_FORMULA_VERSIONS.QC_REPAIR_LOOP_V1);
  });

  it("adds quality_per_token when token and composite evidence exist", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 75_000 },
      run: { ...baseEvidence().run, total_children: 1 },
      children: [makeChild()],
      intervention: { ...baseEvidence().intervention, user_intervened: false, foreman_intervened: false },
      worker: { ...baseEvidence().worker, workers_succeeded: 1 },
    });
    const scorecard = computeForemanScorecard(ev);
    const qpt = scorecard.subscores.find((s) => s.dimension === "quality_per_token");
    expect(qpt).toBeDefined();
    expect(qpt?.score).toBeGreaterThan(0);
  });
});

// ── Worker scorecard ──────────────────────────────────────────────────────────

describe("computeWorkerScorecard", () => {
  it("returns null when child not found", () => {
    expect(computeWorkerScorecard(baseEvidence(), "POL-999")).toBeNull();
  });

  it("produces a scorecard for a child with all dimensions", () => {
    const child = makeChild();
    const ev = baseEvidence({ children: [child] });
    const scorecard = computeWorkerScorecard(ev, "POL-001");
    expect(scorecard).not.toBeNull();
    expect(scorecard!.subject).toBe("worker");
    expect(scorecard!.subscores.some((s) => s.dimension === "token")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "duration")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "validation")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "qc")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "repair_iterations")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "scope_adherence")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "acceptance_criteria")).toBe(true);
    expect(scorecard!.subscores.some((s) => s.dimension === "first_pass")).toBe(true);
  });

  it("includes per-child token subscore when tokens_by_child present", () => {
    const child = makeChild();
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, tokens_by_child: { "POL-001": 150_000 } },
    });
    const scorecard = computeWorkerScorecard(ev, "POL-001");
    const token = scorecard!.subscores.find((s) => s.dimension === "token");
    expect(token?.score).toBe(1.0);
    expect(scorecard!.raw_metrics.worker_tokens_used).toBe(150_000);
  });

  it("includes QC severity skipped reason when QC evidence is future", () => {
    const child = makeChild();
    const ev = baseEvidence({ children: [child] });
    const scorecard = computeWorkerScorecard(ev, "POL-001");
    const qc = scorecard!.subscores.find((s) => s.dimension === "qc");
    expect(qc?.score).toBeNull();
    expect(qc?.skipped_reason).toBeTruthy();
  });

  it("computes quality_per_token from worker composite and tokens", () => {
    const child = makeChild({ heartbeat_count: 5 });
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, tokens_by_child: { "POL-001": 100_000 } },
      intervention: { ...baseEvidence().intervention, user_intervened: false, foreman_intervened: false },
    });
    const scorecard = computeWorkerScorecard(ev, "POL-001");
    const qpt = scorecard!.subscores.find((s) => s.dimension === "quality_per_token");
    expect(qpt).toBeDefined();
    expect(qpt!.score).toBeGreaterThan(0);
  });
});

// ── Provider scorecard ────────────────────────────────────────────────────────

describe("computeProviderScorecard", () => {
  it("produces a provider scorecard with all dimensions", () => {
    const ev = baseEvidence({ children: [makeChild()] });
    const scorecard = computeProviderScorecard(ev, "devin");
    expect(scorecard.subject).toBe("provider");
    expect(scorecard.subject_key).toBe("devin");
    const dimensions = scorecard.subscores.map((s) => s.dimension);
    expect(dimensions).toContain("startup_failure");
    expect(dimensions).toContain("quota_exhaustion");
    expect(dimensions).toContain("fallback_frequency");
    expect(dimensions).toContain("role_suitability");
    expect(dimensions).toContain("runtime");
    expect(dimensions).toContain("token_efficiency");
    expect(dimensions).toContain("quality_outcomes");
  });

  it("scores startup_failure and quota_exhaustion from router decisions", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: null,
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: true,
      exhausted_reason: "quota-exceeded",
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild({ status: "failed" })],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 1,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        decisions: [decision],
        recurring_failure_reasons: [],
      },
    });
    const scorecard = computeProviderScorecard(ev, "devin");
    const startup = scorecard.subscores.find((s) => s.dimension === "startup_failure");
    const quota = scorecard.subscores.find((s) => s.dimension === "quota_exhaustion");
    expect(startup?.score).toBe(0.0);
    expect(quota?.score).toBe(0.0);
    expect(scorecard.raw_metrics.provider_startup_failures).toBe(1);
    expect(scorecard.raw_metrics.provider_exhausted_decisions).toBe(1);
  });

  it("scores fallback_frequency lower when provider was fallback target", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["claude", "devin"],
      fallback_used: true,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild()],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 0,
        fallback_attempts: 1,
        successful_fallbacks: 1,
        decisions: [decision],
        recurring_failure_reasons: [],
      },
    });
    const scorecard = computeProviderScorecard(ev, "devin");
    const fallback = scorecard.subscores.find((s) => s.dimension === "fallback_frequency");
    expect(fallback?.score).toBeLessThan(1.0);
    expect(scorecard.raw_metrics.provider_fallback_attempts).toBe(1);
  });

  it("scores role_suitability and quality_outcomes by success rate", () => {
    const ev = baseEvidence({ children: [makeChild({ status: "done", validation: "passed" })] });
    const scorecard = computeProviderScorecard(ev, "devin");
    const role = scorecard.subscores.find((s) => s.dimension === "role_suitability");
    const quality = scorecard.subscores.find((s) => s.dimension === "quality_outcomes");
    expect(role?.score).toBe(1.0);
    expect(quality?.score).toBe(1.0);
  });
});

// ── Model scorecard ───────────────────────────────────────────────────────────

describe("computeModelScorecard", () => {
  it("produces a model scorecard grouped by grouping_keys.model", () => {
    const ev = baseEvidence({ children: [makeChild()] });
    const scorecard = computeModelScorecard(ev, "claude-3-7-sonnet");
    expect(scorecard.subject).toBe("model");
    expect(scorecard.subject_key).toBe("claude-3-7-sonnet");
    const dimensions = scorecard.subscores.map((s) => s.dimension);
    expect(dimensions).toContain("startup_failure");
    expect(dimensions).toContain("token_efficiency");
    expect(dimensions).toContain("quality_outcomes");
  });

  it("distinguishes model-specific startup failures", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: null,
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: true,
      exhausted_reason: "model-error",
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild({ status: "failed" })],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 1,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        decisions: [decision],
        recurring_failure_reasons: [],
      },
    });
    const scorecard = computeModelScorecard(ev, "claude-3-7-sonnet");
    const startup = scorecard.subscores.find((s) => s.dimension === "startup_failure");
    expect(startup?.score).toBe(0.0);
    expect(scorecard.raw_metrics.model_startup_failures).toBe(1);
  });
});

// ── Routing scorecard ─────────────────────────────────────────────────────────

describe("computeRoutingScorecard", () => {
  it("produces a routing scorecard with all required dimensions", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({ children: [makeChild()] });
    const scorecard = computeRoutingScorecard(ev, decision);
    expect(scorecard.subject).toBe("routing");
    const dimensions = scorecard.subscores.map((s) => s.dimension);
    expect(dimensions).toContain("route_selected");
    expect(dimensions).toContain("candidates");
    expect(dimensions).toContain("fallback_path");
    expect(dimensions).toContain("outcome_quality");
    expect(dimensions).toContain("token_burn");
    expect(dimensions).toContain("qc_result");
    expect(dimensions).toContain("validation_result");
    expect(dimensions).toContain("confirmed_signal");
  });

  it("route_selected scores 0.0 when router exhausted", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: null,
      providers_tried: ["devin", "claude"],
      fallback_used: false,
      exhausted: true,
      exhausted_reason: "all-exhausted",
      rejection_reasons: ["quota"],
    };
    const ev = baseEvidence({ children: [makeChild({ status: "failed" })] });
    const scorecard = computeRoutingScorecard(ev, decision);
    const routeSelected = scorecard.subscores.find((s) => s.dimension === "route_selected");
    expect(routeSelected?.score).toBe(0.0);
    expect(scorecard.raw_metrics.router_exhausted).toBe(true);
    expect(scorecard.raw_metrics.router_exhausted_reason).toBe("all-exhausted");
  });

  it("fallback_path scores 0.5 on successful fallback", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["claude", "devin"],
      fallback_used: true,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({ children: [makeChild()] });
    const scorecard = computeRoutingScorecard(ev, decision);
    const fallbackPath = scorecard.subscores.find((s) => s.dimension === "fallback_path");
    expect(fallbackPath?.score).toBe(0.5);
    expect(scorecard.raw_metrics.router_fallback_used).toBe(true);
  });

  it("confirmed_signal scores 1.0 for done+passed child", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({ children: [makeChild({ status: "done", validation: "passed" })] });
    const scorecard = computeRoutingScorecard(ev, decision);
    const confirmed = scorecard.subscores.find((s) => s.dimension === "confirmed_signal");
    expect(confirmed?.score).toBe(1.0);
  });

  it("token_burn uses per-child token usage when available", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild()],
      tokens: { ...baseEvidence().tokens, tokens_by_child: { "POL-001": 350_000 } },
    });
    const scorecard = computeRoutingScorecard(ev, decision);
    const tokenBurn = scorecard.subscores.find((s) => s.dimension === "token_burn");
    expect(tokenBurn?.score).toBeCloseTo(0.5, 2);
    expect(scorecard.raw_metrics.worker_tokens_used).toBe(350_000);
  });
});

// ── Batch scorecards ──────────────────────────────────────────────────────────

describe("computeAllScorecards", () => {
  it("produces all scorecard subjects for a run with evidence", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild()],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 0,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        decisions: [decision],
        recurring_failure_reasons: [],
      },
    });
    const all = computeAllScorecards(ev);
    expect(all.foreman.subject).toBe("foreman");
    expect(all.workers).toHaveLength(1);
    expect(all.providers).toHaveLength(1);
    expect(all.providers[0]!.subject_key).toBe("devin");
    expect(all.models).toHaveLength(1);
    expect(all.models[0]!.subject_key).toBe("claude-3-7-sonnet");
    expect(all.routing).toHaveLength(1);
  });

  it("returns empty provider/model/routing lists when no evidence exists", () => {
    const all = computeAllScorecards(baseEvidence());
    expect(all.workers).toHaveLength(0);
    expect(all.providers).toHaveLength(0);
    expect(all.models).toHaveLength(0);
    expect(all.routing).toHaveLength(0);
  });
});

// ── Raw metrics builders ────────────────────────────────────────────────────

describe("raw metrics builders", () => {
  it("buildForemanRawMetrics captures bootstrap tokens and worker aggregates", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 120_000 },
      worker: { ...baseEvidence().worker, workers_succeeded: 2, workers_failed: 1 },
    });
    const metrics = buildForemanRawMetrics(ev);
    expect(metrics.max_bootstrap_tokens).toBe(120_000);
    expect(metrics.workers_succeeded).toBe(2);
    expect(metrics.workers_failed).toBe(1);
  });

  it("buildWorkerRawMetrics captures per-child tokens and validation", () => {
    const child = makeChild();
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, tokens_by_child: { "POL-001": 50_000 } },
      validation: [{ child_id: "POL-001", outcome: "passed", passed_commands: ["npm test"], error_message: null }],
    });
    const metrics = buildWorkerRawMetrics(ev, child);
    expect(metrics.worker_tokens_used).toBe(50_000);
    expect(metrics.validation_outcome).toBe("passed");
    expect(metrics.passed_commands).toContain("npm test");
  });

  it("buildProviderRawMetrics aggregates provider-specific counts", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild()],
      router: {
        availability: "available",
        total_decisions: 1,
        exhausted_decisions: 0,
        fallback_attempts: 0,
        successful_fallbacks: 0,
        decisions: [decision],
        recurring_failure_reasons: [],
      },
    });
    const metrics = buildProviderRawMetrics(ev, "devin");
    expect(metrics.provider_decisions).toBe(1);
    expect(metrics.workers_succeeded).toBe(1);
    expect(metrics.provider_selected).toBe("devin");
  });

  it("buildModelRawMetrics uses child grouping_keys.model", () => {
    const ev = baseEvidence({ children: [makeChild()] });
    const metrics = buildModelRawMetrics(ev, "claude-3-7-sonnet");
    expect(metrics.model_decisions).toBe(0); // no router decisions in future availability
    expect(metrics.workers_succeeded).toBe(1);
  });

  it("buildRoutingRawMetrics maps decision to child metrics", () => {
    const decision: SolRouterDecisionEvidence = {
      child_id: "POL-001",
      selected_provider: "devin",
      providers_tried: ["devin"],
      fallback_used: false,
      exhausted: false,
      exhausted_reason: null,
      rejection_reasons: [],
    };
    const ev = baseEvidence({
      children: [makeChild()],
      validation: [{ child_id: "POL-001", outcome: "passed", passed_commands: ["npm test"], error_message: null }],
    });
    const metrics = buildRoutingRawMetrics(ev, decision);
    expect(metrics.provider_selected).toBe("devin");
    expect(metrics.router_child_status).toBe("done");
    expect(metrics.router_child_validation).toBe("passed");
    expect(metrics.router_candidates_count).toBe(1);
  });
});
