import { describe, expect, it } from "vitest";
import { generateRunReport } from "./run-report.js";
import type { RunReportData } from "./run-report.js";
import type { QcScoreSummary } from "../autoresearch/score.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function minimalState(): RunReportData["state"] {
  return {
    schema_version: "1.0",
    run_id: "test-run-001",
    cluster_id: "POL-000",
    active_child: "",
    completed_children: ["POL-001", "POL-002"],
    open_children: [],
    step_cursor: "CLUSTER-COMPLETE",
    status: "complete",
    next_open_child: null,
    context_budget: { children_completed: 2 },
  };
}

function baseReportData(overrides: Partial<RunReportData> = {}): RunReportData {
  return {
    state: minimalState(),
    branch: "feature/test",
    validationPassed: true,
    ...overrides,
  };
}

function makeQcSummary(overrides: Partial<QcScoreSummary> = {}): QcScoreSummary {
  return {
    total_findings: 0,
    blocking_findings: 0,
    autofixed_findings: 0,
    repaired_findings: 0,
    waived_findings: 0,
    unvalidated_findings: 0,
    open_by_severity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    blocks_delivery: false,
    qc_run_count: 1,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("generateRunReport", () => {
  it("omits QC section when qcSummary is not provided", () => {
    const report = generateRunReport(baseReportData());
    expect(report).not.toContain("## QC summary");
  });

  it("omits QC section when qcSummary is null", () => {
    const report = generateRunReport(baseReportData({ qcSummary: null }));
    expect(report).not.toContain("## QC summary");
  });

  it("includes QC section when qcSummary is provided", () => {
    const report = generateRunReport(baseReportData({ qcSummary: makeQcSummary() }));
    expect(report).toContain("## QC summary");
    expect(report).toContain("**QC runs:** 1");
    expect(report).toContain("Not blocking delivery");
  });

  it("shows BLOCKED status when blocks_delivery is true", () => {
    const report = generateRunReport(
      baseReportData({ qcSummary: makeQcSummary({ blocks_delivery: true, blocking_findings: 2 }) }),
    );
    expect(report).toContain("BLOCKED");
    expect(report).toContain("2");
  });

  it("reports total and blocking finding counts correctly", () => {
    const qcSummary = makeQcSummary({
      total_findings: 5,
      blocking_findings: 2,
      autofixed_findings: 1,
      repaired_findings: 1,
      unvalidated_findings: 1,
      open_by_severity: { critical: 1, high: 1, medium: 0, low: 0, info: 0 },
    });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("**Total findings:** 5");
    expect(report).toContain("critical=1");
    expect(report).toContain("high=1");
  });

  it("shows unvalidated finding count in parenthetical", () => {
    const qcSummary = makeQcSummary({ total_findings: 3, unvalidated_findings: 2 });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("2 unvalidated/provider-noise excluded from scoring");
  });
});
