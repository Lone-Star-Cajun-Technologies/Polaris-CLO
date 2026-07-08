/**
 * Tests for the SOL scoring engine (sol-scorer.ts).
 *
 * Coverage:
 *   - computeForemanScore: all dimensions, high-confidence scoring, partial evidence, no-evidence fallback
 *   - computeWorkerScore: all dimensions, high-confidence scoring, partial evidence, no-evidence fallback
 *   - computeSolScoreReport: full run report shape, worker map, run composite
 *   - Confidence tiers: high/medium/low/none
 *   - Missing evidence: skipped dimensions carry skipped_reason
 *   - Grouping behavior: multiple children scored independently
 */

import { describe, expect, it } from "vitest";
import { computeForemanScore, computeWorkerScore, computeSolScoreReport } from "./sol-scorer.js";
import type { SolEvidence, SolChildEvidence, SolQcEvidence } from "../types/sol-evidence.js";
import type { WorkerResultContract } from "../types/result-packet.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseEvidence(overrides: Partial<SolEvidence> = {}): SolEvidence {
  return {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: null,
    observed_at: new Date().toISOString(),
    grouping_keys: {},
    run: {
      run_id: "test-run-001",
      cluster_id: null,
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

function makeChild(overrides: Partial<SolChildEvidence> = {}): SolChildEvidence {
  return {
    child_id: "POL-001",
    run_id: "test-run-001",
    cluster_id: "POL-000",
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
    grouping_keys: {},
    ...overrides,
  };
}

// ── computeForemanScore: no evidence (all skipped) ────────────────────────────

describe("computeForemanScore: no evidence (empty run)", () => {
  it("returns composite_score=null and composite_confidence=none when all dimensions skipped", () => {
    const report = computeForemanScore(baseEvidence());
    expect(report.composite_score).toBeNull();
    expect(report.composite_confidence).toBe("none");
  });

  it("all dimension scores are null when no evidence", () => {
    const report = computeForemanScore(baseEvidence());
    expect(report.token.score).toBeNull();
    expect(report.duration.score).toBeNull();
    expect(report.intervention.score).toBeNull();
    expect(report.pre_analysis.score).toBeNull();
  });

  it("skipped dimensions carry skipped_reason", () => {
    const report = computeForemanScore(baseEvidence());
    expect(report.token.skipped_reason).toBeTruthy();
    expect(report.duration.skipped_reason).toBeTruthy();
  });

  it("skipped dimensions have confidence=none", () => {
    const report = computeForemanScore(baseEvidence());
    expect(report.token.confidence).toBe("none");
    expect(report.duration.confidence).toBe("none");
  });
});

// ── computeForemanScore: high-confidence scoring ─────────────────────────────

describe("computeForemanScore: high-confidence scoring", () => {
  it("token: score=1.0 when max_bootstrap_tokens <= 150k", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 100_000, over_token_budget: false },
    });
    const report = computeForemanScore(ev);
    expect(report.token.score).toBe(1.0);
    expect(report.token.confidence).toBe("high");
  });

  it("token: score=0.0 when max_bootstrap_tokens >= 300k", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 300_000, over_token_budget: true },
    });
    const report = computeForemanScore(ev);
    expect(report.token.score).toBe(0.0);
    expect(report.token.confidence).toBe("high");
  });

  it("token: score decays linearly between 150k and 300k", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 225_000, over_token_budget: true },
    });
    const report = computeForemanScore(ev);
    expect(report.token.score).toBeCloseTo(0.5, 2);
  });

  it("intervention: score=1.0 with no interventions (has children)", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 2 },
      children: [makeChild()],
      intervention: { ...baseEvidence().intervention, user_intervened: false, foreman_intervened: false },
    });
    const report = computeForemanScore(ev);
    expect(report.intervention.score).toBe(1.0);
    expect(report.intervention.confidence).toBe("high");
  });

  it("intervention: score=0.5 when foreman_intervened=true", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 1 },
      children: [makeChild()],
      intervention: { ...baseEvidence().intervention, foreman_intervened: true },
    });
    const report = computeForemanScore(ev);
    expect(report.intervention.score).toBe(0.5);
  });

  it("intervention: score=0.0 when user_intervened=true", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 1 },
      children: [makeChild()],
      intervention: { ...baseEvidence().intervention, user_intervened: true },
    });
    const report = computeForemanScore(ev);
    expect(report.intervention.score).toBe(0.0);
  });

  it("dispatch: score=1.0 when no redispatched children", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 3 },
      foreman: { ...baseEvidence().foreman, redispatch_count: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.dispatch.score).toBe(1.0);
  });

  it("dispatch: score decreases with redispatched children", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 4 },
      foreman: { ...baseEvidence().foreman, redispatch_count: 2, redispatched_children: ["POL-001", "POL-002"] },
    });
    const report = computeForemanScore(ev);
    // 1 - 2/4 = 0.5
    expect(report.dispatch.score).toBeCloseTo(0.5, 2);
  });

  it("completion: score=1.0 when all children succeeded", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 3 },
      worker: { ...baseEvidence().worker, workers_succeeded: 3, workers_failed: 0, workers_blocked: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.completion.score).toBe(1.0);
  });

  it("completion: score=0.5 when half succeeded", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 4 },
      worker: { ...baseEvidence().worker, workers_succeeded: 2, workers_failed: 2 },
    });
    const report = computeForemanScore(ev);
    expect(report.completion.score).toBe(0.5);
  });

  it("recovery: score=1.0 when no state repair required (with cluster signal)", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, cluster_id: "POL-000" },
      intervention: { ...baseEvidence().intervention, state_repair_required: false },
    });
    const report = computeForemanScore(ev);
    expect(report.recovery.score).toBe(1.0);
  });

  it("recovery: score=0.0 when state repair required", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, cluster_id: "POL-000" },
      intervention: { ...baseEvidence().intervention, state_repair_required: true },
    });
    const report = computeForemanScore(ev);
    expect(report.recovery.score).toBe(0.0);
    expect(report.recovery.confidence).toBe("high");
  });
});

// ── computeForemanScore: partial evidence ─────────────────────────────────────

describe("computeForemanScore: partial evidence", () => {
  it("composite is computed from available (non-null) dimensions only", () => {
    // Provide only token evidence; all others skipped
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 100_000 },
    });
    const report = computeForemanScore(ev);
    // composite is just the token score = 1.0
    expect(report.composite_score).toBe(1.0);
  });

  it("composite is average of available dimensions", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 2, cluster_id: "POL-000", dispatch_epoch: 1, continue_epoch: 0 },
      children: [makeChild()],
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 100_000, redispatch_count: 0 },
      worker: { ...baseEvidence().worker, workers_succeeded: 2, workers_failed: 0 },
      intervention: { ...baseEvidence().intervention, user_intervened: false, foreman_intervened: false },
    });
    const report = computeForemanScore(ev);
    // All scored dimensions are 1.0 or close to it
    expect(report.composite_score).toBeGreaterThan(0.8);
  });

  it("scope dimension skipped when no blocked events and no telemetry heartbeats", () => {
    const ev = baseEvidence({
      tokens: { ...baseEvidence().tokens, total_worker_heartbeats: 0 },
      intervention: { ...baseEvidence().intervention, blocked_event_count: 0, out_of_scope_count: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.scope.score).toBeNull();
    expect(report.scope.skipped_reason).toBeTruthy();
  });

  it("scope: score=1.0 when telemetry exists but no out-of-scope events", () => {
    const ev = baseEvidence({
      tokens: { ...baseEvidence().tokens, total_worker_heartbeats: 5 },
      intervention: { ...baseEvidence().intervention, blocked_event_count: 2, out_of_scope_count: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.scope.score).toBe(1.0);
  });

  it("scope: score decays with out-of-scope events", () => {
    const ev = baseEvidence({
      tokens: { ...baseEvidence().tokens, total_worker_heartbeats: 5 },
      intervention: { ...baseEvidence().intervention, blocked_event_count: 2, out_of_scope_count: 1 },
    });
    const report = computeForemanScore(ev);
    expect(report.scope.score).toBe(0.5);
  });

  it("pre_analysis: score=1.0 when dispatch_epoch set and no escalations", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, dispatch_epoch: 1 },
      foreman: { ...baseEvidence().foreman, escalation_events: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.pre_analysis.score).toBe(1.0);
    expect(report.pre_analysis.confidence).toBe("medium");
  });

  it("pre_analysis: score reduces with escalation events", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, dispatch_epoch: 2 },
      foreman: { ...baseEvidence().foreman, escalation_events: 2 },
    });
    const report = computeForemanScore(ev);
    // 1.0 - 2 * 0.25 = 0.5
    expect(report.pre_analysis.score).toBeCloseTo(0.5, 2);
    expect(report.pre_analysis.confidence).toBe("high");
  });

  it("evidence_validation: score increases with heartbeats per child", () => {
    const ev = baseEvidence({
      children: [makeChild({ heartbeat_count: 5 }), makeChild({ child_id: "POL-002", heartbeat_count: 5 })],
      worker: { ...baseEvidence().worker, total_heartbeats: 10 },
    });
    const report = computeForemanScore(ev);
    // 10 / 2 = 5 heartbeats per child → score = 1.0
    expect(report.evidence_validation.score).toBe(1.0);
  });

  it("evidence_validation: score < 1.0 when mean heartbeats < 5", () => {
    const ev = baseEvidence({
      children: [makeChild({ heartbeat_count: 2 })],
      worker: { ...baseEvidence().worker, total_heartbeats: 2 },
    });
    const report = computeForemanScore(ev);
    // 2/5 = 0.4
    expect(report.evidence_validation.score).toBeCloseTo(0.4, 2);
  });

  it("dependency: score=1.0 with no redispatches and dispatch_epoch present", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, total_children: 3, dispatch_epoch: 1 },
      foreman: { ...baseEvidence().foreman, redispatch_count: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.dependency.score).toBe(1.0);
  });

  it("duration: score=1.0 at epoch 1 (expected 1)", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, dispatch_epoch: 1, continue_epoch: 0 },
    });
    const report = computeForemanScore(ev);
    expect(report.duration.score).toBe(1.0);
  });

  it("duration: score reduces with epoch overhead", () => {
    const ev = baseEvidence({
      run: { ...baseEvidence().run, dispatch_epoch: 4, continue_epoch: 1 },
    });
    const report = computeForemanScore(ev);
    // expected = 2, overhead = 2 → 1 - 2*0.25 = 0.5
    expect(report.duration.score).toBeCloseTo(0.5, 2);
  });
});

// ── computeWorkerScore: no evidence fallback ──────────────────────────────────

describe("computeWorkerScore: no evidence (child not in evidence)", () => {
  it("returns null when child not found in evidence", () => {
    const report = computeWorkerScore("POL-999", baseEvidence());
    expect(report).toBeNull();
  });
});

describe("computeWorkerScore: minimal child (null interventions)", () => {
  it("all null-intervention dimensions are skipped", () => {
    const child = makeChild({ user_intervened: null, foreman_intervened: null });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report).not.toBeNull();
    expect(report!.first_pass.score).toBeNull();
    expect(report!.first_pass.skipped_reason).toBeTruthy();
  });

  it("qc dimension skipped when qc availability=future", () => {
    const child = makeChild();
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.qc.score).toBeNull();
    expect(report!.qc.skipped_reason).toBeTruthy();
  });
});

// ── computeWorkerScore: high-confidence scoring ───────────────────────────────

describe("computeWorkerScore: high-confidence scoring", () => {
  it("validation: score=1.0 when validation=passed", () => {
    const child = makeChild({ validation: "passed" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.validation.score).toBe(1.0);
    expect(report!.validation.confidence).toBe("high");
  });

  it("validation: score=0.0 when validation=failed", () => {
    const child = makeChild({ validation: "failed" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.validation.score).toBe(0.0);
    expect(report!.validation.confidence).toBe("high");
  });

  it("validation: skipped when validation=skipped", () => {
    const child = makeChild({ validation: "skipped" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.validation.score).toBeNull();
    expect(report!.validation.skipped_reason).toBeTruthy();
  });

  it("first_pass: score=1.0 when both intervention flags are false", () => {
    const child = makeChild({ user_intervened: false, foreman_intervened: false });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.first_pass.score).toBe(1.0);
    expect(report!.first_pass.confidence).toBe("high");
  });

  it("first_pass: score=0.0 when user_intervened=true", () => {
    const child = makeChild({ user_intervened: true, foreman_intervened: false });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.first_pass.score).toBe(0.0);
  });

  it("first_pass: score=0.5 when foreman_intervened=true", () => {
    const child = makeChild({ user_intervened: false, foreman_intervened: true });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.first_pass.score).toBe(0.5);
  });

  it("acceptance_criteria: score=1.0 for done + passed", () => {
    const child = makeChild({ status: "done", validation: "passed" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.acceptance_criteria.score).toBe(1.0);
    expect(report!.acceptance_criteria.confidence).toBe("high");
  });

  it("acceptance_criteria: score=0.0 for failed status", () => {
    const child = makeChild({ status: "failed", validation: "failed" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.acceptance_criteria.score).toBe(0.0);
  });

  it("acceptance_criteria: score=0.0 for blocked status", () => {
    const child = makeChild({ status: "blocked" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.acceptance_criteria.score).toBe(0.0);
  });

  it("repair_iterations: score=1.0 when escalation_count=0", () => {
    const child = makeChild({ escalation_count: 0 });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.repair_iterations.score).toBe(1.0);
    expect(report!.repair_iterations.confidence).toBe("medium");
  });

  it("repair_iterations: score reduces with escalation_count", () => {
    const child = makeChild({ escalation_count: 2 });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    // 1.0 - 2 * 0.25 = 0.5
    expect(report!.repair_iterations.score).toBeCloseTo(0.5, 2);
    expect(report!.repair_iterations.confidence).toBe("high");
  });

  it("scope_adherence: score=0.0 when worker status=blocked", () => {
    const child = makeChild({ status: "blocked" });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.scope_adherence.score).toBe(0.0);
    expect(report!.scope_adherence.confidence).toBe("high");
  });

  it("scope_adherence: score=0.5 with run-level out-of-scope events (low confidence)", () => {
    const child = makeChild({ status: "done" });
    const ev = baseEvidence({
      children: [child],
      intervention: { ...baseEvidence().intervention, out_of_scope_count: 1 },
    });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.scope_adherence.score).toBe(0.5);
    expect(report!.scope_adherence.confidence).toBe("low");
  });

  it("scope_adherence: score=1.0 with no out-of-scope events and heartbeats", () => {
    const child = makeChild({ status: "done" });
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, total_worker_heartbeats: 5 },
      intervention: { ...baseEvidence().intervention, out_of_scope_count: 0 },
    });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.scope_adherence.score).toBe(1.0);
    expect(report!.scope_adherence.confidence).toBe("medium");
  });
});

// ── computeWorkerScore: partial evidence ──────────────────────────────────────

describe("computeWorkerScore: partial evidence", () => {
  it("token: skipped when no per-child token data", () => {
    const child = makeChild({ heartbeat_count: 0 });
    const ev = baseEvidence({ children: [child], tokens: { ...baseEvidence().tokens, tokens_by_child: {} } });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.token.score).toBeNull();
  });

  it("token: skipped with reason when heartbeat_count=0 and no token data", () => {
    const child = makeChild({ heartbeat_count: 0 });
    const ev = baseEvidence({ children: [child], tokens: { ...baseEvidence().tokens, tokens_by_child: {} } });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.token.skipped_reason).toBeTruthy();
  });

  it("token: score=1.0 when per-child tokens_used <= 200k", () => {
    const child = makeChild();
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, tokens_by_child: { "POL-001": 150_000 } },
    });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.token.score).toBe(1.0);
    expect(report!.token.confidence).toBe("high");
  });

  it("token: score decays above 200k tokens", () => {
    const child = makeChild();
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, tokens_by_child: { "POL-001": 350_000 } },
    });
    const report = computeWorkerScore("POL-001", ev);
    // (350k - 200k) / (500k - 200k) = 0.5 → score = 0.5
    expect(report!.token.score).toBeCloseTo(0.5, 2);
  });

  it("duration: score=1.0 when heartbeat_count <= 10", () => {
    const child = makeChild({ heartbeat_count: 6 });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.duration.score).toBe(1.0);
    expect(report!.duration.confidence).toBe("medium");
  });

  it("duration: score decays above 10 heartbeats", () => {
    const child = makeChild({ heartbeat_count: 20 });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    // 1.0 - (20 - 10) * 0.05 = 0.5
    expect(report!.duration.score).toBeCloseTo(0.5, 2);
  });

  it("duration: skipped when heartbeat_count=0", () => {
    const child = makeChild({ heartbeat_count: 0 });
    const ev = baseEvidence({ children: [child] });
    const report = computeWorkerScore("POL-001", ev);
    expect(report!.duration.score).toBeNull();
    expect(report!.duration.skipped_reason).toBeTruthy();
  });

  it("composite_score is mean of non-null dimensions only", () => {
    // All dims available and scoring 1.0
    const child = makeChild({
      validation: "passed",
      status: "done",
      escalation_count: 0,
      heartbeat_count: 5,
      user_intervened: false,
      foreman_intervened: false,
    });
    const ev = baseEvidence({
      children: [child],
      tokens: { ...baseEvidence().tokens, total_worker_heartbeats: 5 },
    });
    const report = computeWorkerScore("POL-001", ev);
    // All non-skipped dimensions should be 1.0 → composite = 1.0
    expect(report!.composite_score).toBe(1.0);
  });
});

// ── computeWorkerScore: grouping (multiple children) ─────────────────────────

describe("computeWorkerScore: multiple children scored independently", () => {
  it("scores different children independently", () => {
    const child1 = makeChild({ child_id: "POL-001", validation: "passed", status: "done", user_intervened: false, foreman_intervened: false });
    const child2 = makeChild({ child_id: "POL-002", validation: "failed", status: "failed", user_intervened: false, foreman_intervened: false });
    const ev = baseEvidence({ children: [child1, child2] });

    const report1 = computeWorkerScore("POL-001", ev);
    const report2 = computeWorkerScore("POL-002", ev);

    expect(report1!.acceptance_criteria.score).toBe(1.0);
    expect(report2!.acceptance_criteria.score).toBe(0.0);
  });

  it("computeSolScoreReport produces one report per child", () => {
    const children = [
      makeChild({ child_id: "POL-001" }),
      makeChild({ child_id: "POL-002" }),
    ];
    const ev = baseEvidence({ children, run: { ...baseEvidence().run, total_children: 2 } });
    const fullReport = computeSolScoreReport(ev);
    expect(Object.keys(fullReport.workers)).toHaveLength(2);
    expect(fullReport.workers["POL-001"]).toBeDefined();
    expect(fullReport.workers["POL-002"]).toBeDefined();
  });
});

// ── computeSolScoreReport: full run report ────────────────────────────────────

describe("computeSolScoreReport", () => {
  it("returns required fields", () => {
    const fullReport = computeSolScoreReport(baseEvidence());
    expect(typeof fullReport.run_id).toBe("string");
    expect(typeof fullReport.scored_at).toBe("string");
    expect(typeof fullReport.foreman).toBe("object");
    expect(typeof fullReport.workers).toBe("object");
    expect(fullReport.run_composite_score === null || typeof fullReport.run_composite_score === "number").toBe(true);
  });

  it("run_composite_score is null when no evidence", () => {
    const fullReport = computeSolScoreReport(baseEvidence());
    expect(fullReport.run_composite_score).toBeNull();
  });

  it("run_composite_score is numeric when some evidence is present", () => {
    const ev = baseEvidence({
      foreman: { ...baseEvidence().foreman, max_bootstrap_tokens: 100_000 },
      run: { ...baseEvidence().run, total_children: 1 },
      children: [makeChild({ status: "done", validation: "passed", user_intervened: false, foreman_intervened: false })],
    });
    const fullReport = computeSolScoreReport(ev);
    expect(fullReport.run_composite_score).not.toBeNull();
    expect(fullReport.run_composite_score).toBeGreaterThan(0);
    expect(fullReport.run_composite_score).toBeLessThanOrEqual(1);
  });

  it("workers map is empty when no children in evidence", () => {
    const fullReport = computeSolScoreReport(baseEvidence());
    expect(Object.keys(fullReport.workers)).toHaveLength(0);
  });

  it("cluster_id is propagated to the score report", () => {
    const ev = baseEvidence({ cluster_id: "POL-777", run: { ...baseEvidence().run, cluster_id: "POL-777" } });
    const fullReport = computeSolScoreReport(ev);
    expect(fullReport.cluster_id).toBe("POL-777");
  });

  it("full happy-path run produces composite scores > 0.8", () => {
    const children = [
      makeChild({ child_id: "POL-001", validation: "passed", status: "done", escalation_count: 0, heartbeat_count: 5, user_intervened: false, foreman_intervened: false }),
      makeChild({ child_id: "POL-002", validation: "passed", status: "done", escalation_count: 0, heartbeat_count: 6, user_intervened: false, foreman_intervened: false }),
    ];
    const ev = baseEvidence({
      run: {
        ...baseEvidence().run,
        total_children: 2,
        completed_children: 2,
        dispatch_epoch: 1,
        continue_epoch: 0,
        cluster_id: "POL-000",
      },
      children,
      foreman: {
        max_bootstrap_tokens: 50_000,
        over_token_budget: false,
        redispatch_count: 0,
        redispatched_children: [],
        foreman_corrective_commit: false,
        escalation_events: 0,
      },
      worker: {
        total_heartbeats: 11,
        total_escalations: 0,
        workers_succeeded: 2,
        workers_failed: 0,
        workers_blocked: 0,
        validation_failures: 0,
        validation_passes: 2,
        user_interventions: 0,
        foreman_interventions: 0,
      },
      tokens: {
        max_bootstrap_tokens: 50_000,
        total_worker_heartbeats: 11,
        tokens_by_child: { "POL-001": 100_000, "POL-002": 80_000 },
      },
      intervention: {
        user_intervened: false,
        foreman_intervened: false,
        blocked_event_count: 0,
        out_of_scope_count: 0,
        state_repair_required: false,
      },
    });

    const fullReport = computeSolScoreReport(ev);
    expect(fullReport.run_composite_score).toBeGreaterThan(0.8);
    expect(fullReport.foreman.composite_score).toBeGreaterThan(0.8);
    expect(fullReport.workers["POL-001"]!.composite_score).toBe(1.0);
    expect(fullReport.workers["POL-002"]!.composite_score).toBe(1.0);
  });
});

// ── Dimension labels ──────────────────────────────────────────────────────────

describe("dimension labels", () => {
  it("foreman score report has all 10 dimension keys", () => {
    const report = computeForemanScore(baseEvidence());
    expect(report.token.dimension).toBe("token");
    expect(report.duration.dimension).toBe("duration");
    expect(report.intervention.dimension).toBe("intervention");
    expect(report.pre_analysis.dimension).toBe("pre_analysis");
    expect(report.dependency.dimension).toBe("dependency");
    expect(report.dispatch.dimension).toBe("dispatch");
    expect(report.evidence_validation.dimension).toBe("evidence_validation");
    expect(report.scope.dimension).toBe("scope");
    expect(report.completion.dimension).toBe("completion");
    expect(report.recovery.dimension).toBe("recovery");
  });

  it("worker score report has all 8 dimension keys", () => {
    const child = makeChild();
    const report = computeWorkerScore("POL-001", baseEvidence({ children: [child] }));
    expect(report!.token.dimension).toBe("token");
    expect(report!.duration.dimension).toBe("duration");
    expect(report!.validation.dimension).toBe("validation");
    expect(report!.qc.dimension).toBe("qc");
    expect(report!.repair_iterations.dimension).toBe("repair_iterations");
    expect(report!.scope_adherence.dimension).toBe("scope_adherence");
    expect(report!.acceptance_criteria.dimension).toBe("acceptance_criteria");
    expect(report!.first_pass.dimension).toBe("first_pass");
  });
});
