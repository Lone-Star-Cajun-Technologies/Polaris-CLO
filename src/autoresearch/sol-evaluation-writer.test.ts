/**
 * Tests for SOL evaluation artifact writer.
 *
 * Coverage:
 *   - Evaluation record creation and path helpers
 *   - Writing evaluation JSON under .polaris/sol/evaluations/
 *   - Writing scorecard snapshots under .polaris/sol/scorecards/<subject>/
 *   - Writing human-readable Markdown reports to smartdocs/reports/sol/
 *   - Path-safety of derived filenames
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEvaluationRecord,
  getEvaluationRecordPath,
  getScorecardPath,
  getSolMarkdownReportPath,
  writeEvaluationRecord,
  writeScorecard,
  writeScorecardSet,
  writeSolMarkdownReport,
  getSolEvaluationsDir,
  getSolScorecardsDir,
  getSolReportsDir,
} from "./sol-evaluation-writer.js";
import type { SolScoreReport } from "../types/sol-score.js";
import type { SolScorecard, SolScorecardRawMetrics, SolSubscore } from "../types/sol-scorecard.js";
import type { SolScorecardSet } from "./sol-scorecard-calculator.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "polaris-sol-writer-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeDimScore(dimension: string, score: number | null): SolSubscore {
  return { dimension, score, confidence: score === null ? "none" : "high", formula_version: "test/1.0" };
}

function makeReport(runId: string): SolScoreReport {
  const dim = (name: string) => makeDimScore(name, 0.8);
  return {
    run_id: runId,
    cluster_id: "POL-100",
    scored_at: new Date().toISOString(),
    foreman: {
      composite_score: 0.8,
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
    workers: {},
    run_composite_score: 0.8,
  };
}

function makeScorecard(subject: SolScorecard["subject"], subjectKey: string): SolScorecard {
  const rawMetrics: SolScorecardRawMetrics = {
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

  return {
    schema_version: "1.0",
    scorecard_id: `${subject}-${subjectKey}-run-001`,
    subject,
    subject_key: subjectKey,
    window: { run_id: "run-001" },
    grouping_keys: {},
    generated_at: new Date().toISOString(),
    availability: "partial",
    raw_metrics: rawMetrics,
    subscores: [makeDimScore("token", 0.8)],
    aggregate_score: 0.8,
    aggregate_confidence: "high",
    source_refs: [{ kind: "run-state", path: "state.json", available: true }],
    recommendation_inputs: {
      below_threshold: false,
      low_scoring_dimensions: [],
      skipped_dimensions: [],
      over_token_budget: false,
      intervention_detected: false,
      router_issue_detected: false,
      qc_issue_detected: false,
      notes: [],
    },
    aggregate_formula_version: "composite-mean/1.0",
  };
}

function makeScorecardSet(): SolScorecardSet {
  return {
    foreman: makeScorecard("foreman", "run-001"),
    workers: [makeScorecard("worker", "POL-001-run-001")],
    providers: [makeScorecard("provider", "devin")],
    models: [makeScorecard("model", "claude-3-7-sonnet")],
    routing: [makeScorecard("routing", "POL-001")],
  };
}

// ── Path helpers ───────────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("return deterministic repo-relative artifact directories", () => {
    expect(getSolEvaluationsDir(tempRoot)).toBe(join(tempRoot, ".polaris/sol/evaluations"));
    expect(getSolScorecardsDir(tempRoot)).toBe(join(tempRoot, ".polaris/sol/scorecards"));
    expect(getSolReportsDir(tempRoot)).toBe(join(tempRoot, "smartdocs/reports/sol"));
  });

  it("sanitizes unsafe characters in scorecard filenames", () => {
    const scorecard = makeScorecard("foreman", "run-001");
    scorecard.scorecard_id = "foreman-foo/../bar";
    const path = getScorecardPath(tempRoot, scorecard);
    expect(path).not.toContain("../");
    expect(path).not.toContain("/bar");
    expect(path).toMatch(/foreman-foo---bar-[0-9a-f]{8}\.json$/);
  });

  it("sanitizes unsafe characters in evaluation run ids", () => {
    const report = makeReport("run/../evil");
    const path = getEvaluationRecordPath(tempRoot, report.run_id);
    expect(path).not.toContain("../");
    expect(path).toMatch(/run---evil-[0-9a-f]{8}\.json$/);
  });

  it("keeps colliding sanitized ids unique", () => {
    const left = getEvaluationRecordPath(tempRoot, "run/a");
    const right = getEvaluationRecordPath(tempRoot, "run:a");
    expect(left).not.toBe(right);
  });
});

// ── Evaluation records ────────────────────────────────────────────────────────

describe("buildEvaluationRecord", () => {
  it("wraps a SolScoreReport with schema metadata", () => {
    const report = makeReport("run-001");
    const record = buildEvaluationRecord(report);
    expect(record.schema_version).toBe("1.0");
    expect(record.record_type).toBe("sol-evaluation");
    expect(record.run_id).toBe("run-001");
    expect(record.report).toBe(report);
  });
});

describe("writeEvaluationRecord", () => {
  it("writes a JSON evaluation record under .polaris/sol/evaluations/", () => {
    const report = makeReport("run-001");
    const { path, record } = writeEvaluationRecord(tempRoot, report);

    expect(path).toBe(join(tempRoot, ".polaris/sol/evaluations/run-001.json"));
    expect(existsSync(path)).toBe(true);

    const parsed = JSON.parse(readFileSync(path, "utf-8")) as typeof record;
    expect(parsed.record_type).toBe("sol-evaluation");
    expect(parsed.run_id).toBe("run-001");
    expect(parsed.report.run_composite_score).toBe(0.8);
  });
});

// ── Scorecard snapshots ───────────────────────────────────────────────────────

describe("writeScorecard", () => {
  it("writes a scorecard snapshot to a subject subdirectory", () => {
    const scorecard = makeScorecard("foreman", "run-001");
    const path = writeScorecard(tempRoot, scorecard);

    expect(path).toBe(join(tempRoot, ".polaris/sol/scorecards/foreman/foreman-run-001-run-001.json"));
    expect(existsSync(path)).toBe(true);

    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SolScorecard;
    expect(parsed.subject).toBe("foreman");
    expect(parsed.scorecard_id).toBe(scorecard.scorecard_id);
  });
});

describe("writeScorecardSet", () => {
  it("writes all scorecards from a SolScorecardSet", () => {
    const paths = writeScorecardSet(tempRoot, makeScorecardSet());

    expect(paths).toHaveLength(5);
    expect(paths.some((p) => p.includes("/foreman/"))).toBe(true);
    expect(paths.some((p) => p.includes("/worker/"))).toBe(true);
    expect(paths.some((p) => p.includes("/provider/"))).toBe(true);
    expect(paths.some((p) => p.includes("/model/"))).toBe(true);
    expect(paths.some((p) => p.includes("/routing/"))).toBe(true);
  });
});

// ── Markdown reports ────────────────────────────────────────────────────────────

describe("writeSolMarkdownReport", () => {
  it("writes a markdown report to smartdocs/reports/sol/", () => {
    const path = writeSolMarkdownReport(tempRoot, "run-001", "# Hello");

    expect(path).toBe(join(tempRoot, "smartdocs/reports/sol/run-001-evaluation-report.md"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("# Hello");
  });
});
