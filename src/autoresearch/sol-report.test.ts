/**
 * Tests for SOL report generator (sol-report.ts).
 *
 * Coverage:
 *   - generateReport: grouping by run_id, provider, model, time_window, multi-dimension
 *   - Report structure: total_snapshots, groups, overall_mean_composite
 *   - formatReportCli: human-readable output
 *   - Empty snapshots: empty report
 */

import { describe, expect, it } from "vitest";
import { generateReport, formatReportCli } from "./sol-report.js";
import type { SolScoreSnapshot } from "./sol-history.js";
import type { SolScoreReport } from "../types/sol-score.js";

// ── Helpers ──

function makeDimScore(dimension: string, score: number | null) {
  return { dimension, score, confidence: "high" as const };
}

function makeReport(runId: string, compositeScore: number | null, scoredAt?: string): SolScoreReport {
  const dim = (name: string) => makeDimScore(name, compositeScore);
  return {
    run_id: runId,
    cluster_id: "POL-100",
    scored_at: scoredAt ?? new Date().toISOString(),
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
  scoredAt?: string,
): SolScoreSnapshot {
  return {
    schema_version: "1.0",
    report: makeReport(runId, compositeScore, scoredAt),
    grouping_keys: groupingKeys,
    worker_ids: workerIds,
  };
}

// ── Tests ──

describe("generateReport: empty input", () => {
  it("returns empty report with zero snapshots", () => {
    const report = generateReport([]);
    expect(report.total_snapshots).toBe(0);
    expect(report.groups).toEqual([]);
    expect(report.overall_mean_composite).toBeNull();
  });
});

describe("generateReport: group by run_id (default)", () => {
  it("creates one group per distinct run_id", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8),
      makeSnapshot("run-2", 0.9),
    ];
    const report = generateReport(snapshots);

    expect(report.total_snapshots).toBe(2);
    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((g) => g.group_key)).toContain("run_id=run-1");
    expect(report.groups.map((g) => g.group_key)).toContain("run_id=run-2");
  });

  it("computes correct mean, min, max composites", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8),
      makeSnapshot("run-1", 0.6),
    ];
    const report = generateReport(snapshots);

    expect(report.groups).toHaveLength(1);
    const g = report.groups[0];
    expect(g.count).toBe(2);
    expect(g.mean_composite).toBe(0.7);
    expect(g.min_composite).toBe(0.6);
    expect(g.max_composite).toBe(0.8);
  });
});

describe("generateReport: group by provider", () => {
  it("groups snapshots by provider key", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8, { provider: "devin" }),
      makeSnapshot("run-2", 0.9, { provider: "devin" }),
      makeSnapshot("run-3", 0.7, { provider: "claude" }),
    ];
    const report = generateReport(snapshots, { groupBy: ["provider"] });

    expect(report.groups).toHaveLength(2);
    const devinGroup = report.groups.find((g) => g.group_key === "provider=devin");
    expect(devinGroup).toBeDefined();
    expect(devinGroup!.count).toBe(2);
    expect(devinGroup!.mean_composite).toBe(0.85);
  });
});

describe("generateReport: group by multiple dimensions", () => {
  it("creates composite group keys", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8, { provider: "devin", role: "worker" }),
      makeSnapshot("run-2", 0.9, { provider: "devin", role: "worker" }),
      makeSnapshot("run-3", 0.7, { provider: "claude", role: "foreman" }),
    ];
    const report = generateReport(snapshots, { groupBy: ["provider", "role"] });

    expect(report.groups).toHaveLength(2);
    expect(report.groups.map((g) => g.group_key)).toContain("provider=devin|role=worker");
  });
});

describe("generateReport: group by worker_id", () => {
  it("groups by worker_id from snapshot metadata", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8, {}, ["w-1"]),
      makeSnapshot("run-2", 0.9, {}, ["w-1"]),
      makeSnapshot("run-3", 0.7, {}, ["w-2"]),
    ];
    const report = generateReport(snapshots, { groupBy: ["worker_id"] });

    expect(report.groups).toHaveLength(2);
  });
});

describe("generateReport: group by time_window", () => {
  it("buckets snapshots by windowDays", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8, {}, [], "2026-01-01T00:00:00.000Z"),
      makeSnapshot("run-2", 0.9, {}, [], "2026-01-02T00:00:00.000Z"),
      makeSnapshot("run-3", 0.7, {}, [], "2026-01-15T00:00:00.000Z"),
    ];
    const report = generateReport(snapshots, { groupBy: ["time_window"], windowDays: 7 });

    // Jan 1 and Jan 2 should be in the same 7-day bucket
    expect(report.groups.length).toBeGreaterThanOrEqual(2);
  });
});

describe("generateReport: overall composite", () => {
  it("computes overall_mean_composite across all snapshots", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8),
      makeSnapshot("run-2", 0.6),
    ];
    const report = generateReport(snapshots);
    expect(report.overall_mean_composite).toBe(0.7);
  });

  it("returns null when all composites are null", () => {
    const snapshots = [
      makeSnapshot("run-1", null),
    ];
    const report = generateReport(snapshots);
    expect(report.overall_mean_composite).toBeNull();
  });
});

describe("generateReport: foreman and worker composite means", () => {
  it("computes mean_foreman_composite and mean_worker_composite", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8),
    ];
    const report = generateReport(snapshots);
    const g = report.groups[0];

    // foreman composite is compositeScore + 0.05 = 0.85
    expect(g.mean_foreman_composite).toBe(0.85);
    // worker composite is compositeScore - 0.05 = 0.75
    expect(g.mean_worker_composite).toBe(0.75);
  });
});

describe("formatReportCli", () => {
  it("renders a human-readable report", () => {
    const snapshots = [
      makeSnapshot("run-1", 0.8, { provider: "devin" }),
    ];
    const report = generateReport(snapshots);
    const output = formatReportCli(report);

    expect(output).toContain("SOL History Report");
    expect(output).toContain("Total snapshots: 1");
    expect(output).toContain("run_id=run-1");
  });

  it("handles empty report", () => {
    const report = generateReport([]);
    const output = formatReportCli(report);

    expect(output).toContain("No data.");
  });
});
