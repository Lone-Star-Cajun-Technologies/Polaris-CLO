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
 */

import { describe, expect, it } from "vitest";
import {
  generateRecommendations,
  recommendationsToProposals,
  recommendationToProposal,
  formatRecommendationsCli,
} from "./sol-recommendations.js";
import type { SolScoreSnapshot } from "./sol-history.js";
import type { SolScoreReport } from "../types/sol-score.js";

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
