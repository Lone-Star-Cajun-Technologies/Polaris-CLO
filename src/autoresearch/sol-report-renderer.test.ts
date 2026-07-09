/**
 * Tests for SOL Markdown report renderer.
 *
 * Coverage:
 *   - Rendered report includes run summary, scorecard index, and per-subject sections
 *   - Source references, confidence, skipped evidence, and recommendation inputs are present
 *   - QC outcome and follow-up recommendations are rendered
 *   - Summary metadata matches input
 */

import { describe, expect, it } from "vitest";
import { computeAllScorecards } from "./sol-scorecard-calculator.js";
import { computeSolScoreReport } from "./sol-scorer.js";
import { buildEvaluationRecord } from "./sol-evaluation-writer.js";
import { renderSolMarkdown } from "./sol-report-renderer.js";
import { generateQcRecommendations } from "./sol-recommendations.js";
import type { SolEvidence, SolQcEvidence } from "../types/sol-evidence.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseEvidence(overrides: Partial<SolEvidence> = {}): SolEvidence {
  return {
    schema_version: "1.0",
    run_id: "run-report-test",
    cluster_id: "POL-100",
    observed_at: new Date().toISOString(),
    grouping_keys: { provider: "devin", model: "claude-3-7-sonnet", task_type: "implementation" },
    run: {
      run_id: "run-report-test",
      cluster_id: "POL-100",
      branch: "pol-100-test",
      status: "complete",
      total_children: 1,
      completed_children: 1,
      dispatch_epoch: 1,
      continue_epoch: 0,
      state_observed_at: null,
    },
    children: [
      {
        child_id: "POL-001",
        run_id: "run-report-test",
        cluster_id: "POL-100",
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
        changed_files: ["src/a.ts"],
        dispatch_epoch: 1,
        grouping_keys: { provider: "devin", model: "claude-3-7-sonnet" },
      },
    ],
    foreman: {
      max_bootstrap_tokens: 100_000,
      over_token_budget: false,
      redispatch_count: 0,
      redispatched_children: [],
      foreman_corrective_commit: false,
      escalation_events: 0,
    },
    worker: {
      total_heartbeats: 5,
      total_escalations: 0,
      workers_succeeded: 1,
      workers_failed: 0,
      workers_blocked: 0,
      validation_failures: 0,
      validation_passes: 1,
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
    validation: [
      { child_id: "POL-001", outcome: "passed", passed_commands: ["npm test"], error_message: null },
    ],
    tokens: {
      max_bootstrap_tokens: 100_000,
      total_worker_heartbeats: 5,
      tokens_by_child: { "POL-001": 150_000 },
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

function qcEvidence(overrides: Partial<SolQcEvidence> = {}): SolQcEvidence {
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

// ── Renderer tests ─────────────────────────────────────────────────────────────

describe("renderSolMarkdown", () => {
  it("renders a report header and run summary", () => {
    const ev = baseEvidence();
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.summary.run_id).toBe("run-report-test");
    expect(rendered.markdown).toContain("# SOL Evaluation Report: run-report-test");
    expect(rendered.markdown).toContain("## Run summary");
    expect(rendered.markdown).toContain("Run composite score");
  });

  it("renders a scorecard index with all subjects", () => {
    const ev = baseEvidence();
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.markdown).toContain("## Scorecard index");
    expect(rendered.markdown).toContain("| foreman |");
    expect(rendered.markdown).toContain("| worker |");
    expect(rendered.markdown).toContain("| provider |");
    expect(rendered.markdown).toContain("| model |");
  });

  it("renders per-subject detail sections", () => {
    const ev = baseEvidence();
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.markdown).toContain("## Foreman");
    expect(rendered.markdown).toContain("## Workers");
    expect(rendered.markdown).toContain("## Providers");
    expect(rendered.markdown).toContain("## Models");
  });

  it("includes source references and confidence", () => {
    const ev = baseEvidence();
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.markdown).toContain("## Source references");
    expect(rendered.markdown).toContain("run-state");
    expect(rendered.markdown).toContain(scorecards.foreman.aggregate_confidence);
  });

  it("includes skipped evidence with reasons", () => {
    const ev = baseEvidence();
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.markdown).toContain("## Skipped evidence");
    // Routing scorecards are skipped when router evidence is "future".
    expect(rendered.markdown).toContain("routing");
  });

  it("includes recommendation inputs summary", () => {
    const ev = baseEvidence();
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.markdown).toContain("## Recommendation inputs");
    expect(rendered.markdown).toContain("| Subject | Key | Flags | Low dimensions | Skipped dimensions |");
  });

  it("includes token efficiency summary", () => {
    const ev = baseEvidence({ tokens: { max_bootstrap_tokens: 100_000, total_worker_heartbeats: 5, tokens_by_child: { "POL-001": 150_000 } } });
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards);

    expect(rendered.markdown).toContain("## Token efficiency");
    expect(rendered.markdown).toContain("quality_per_token");
  });

  it("includes QC outcome and follow-up recommendations", () => {
    const ev = baseEvidence({ qc: qcEvidence({ unresolved_high_severity: 2 }) });
    const report = computeSolScoreReport(ev);
    const scorecards = computeAllScorecards(ev);
    const qcRecommendations = generateQcRecommendations(ev);
    const record = buildEvaluationRecord(report);
    const rendered = renderSolMarkdown(record, scorecards, qcRecommendations);

    expect(rendered.markdown).toContain("## QC outcome");
    expect(rendered.markdown).toContain("QC repair-loop score");
    expect(rendered.markdown).toContain("### QC follow-up recommendations");
    expect(rendered.markdown).toContain("qc-unresolved-high-severity");
  });
});
