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
    telemetryEvents: [],
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
    weighted_open_score: 0,
    qc_penalty: 0,
    blocks_delivery: false,
    qc_run_count: 1,
    provider_breakdown: {},
    routing_breakdown: { original_worker: 0, repair_worker: 0, follow_up: 0, operator_review: 0, unset: 0 },
    category_breakdown: {},
    recurring_child_signals: [],
    recurring_provider_signals: [],
    repair_loop: null,
    noisy_providers: [],
    has_repair_failures: false,
    unresolved_high_severity: 0,
    max_round_exhausted: false,
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
    expect(report).toContain("| **QC runs** | 1 |");
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
    expect(report).toContain("| **Total findings** | 5");
    expect(report).toContain("critical=1");
    expect(report).toContain("high=1");
  });

  it("shows unvalidated finding count in parenthetical", () => {
    const qcSummary = makeQcSummary({ total_findings: 3, unvalidated_findings: 2 });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("2 unvalidated/provider-noise excluded from scoring");
  });

  it("lists provider breakdown", () => {
    const qcSummary = makeQcSummary({
      provider_breakdown: {
        coderabbit: { total: 4, blocking: 1, unvalidated: 1 },
      },
    });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("coderabbit");
    expect(report).toContain("| 4 | 1 | 1 |");
  });

  it("shows repair routing decisions", () => {
    const qcSummary = makeQcSummary({
      routing_breakdown: { original_worker: 1, repair_worker: 2, follow_up: 0, operator_review: 3, unset: 0 },
    });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("operator-review");
    expect(report).toContain("| 3 |");
    expect(report).toContain("repair-worker");
    expect(report).toContain("| 2 |");
  });

  it("shows SOL score impact when qc_penalty is positive", () => {
    const qcSummary = makeQcSummary({ weighted_open_score: 10, qc_penalty: 0.3333 });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("SOL score impact");
    expect(report).toContain("-33.3%");
    expect(report).toContain("weighted open score 10.00");
  });

  it("shows no SOL score impact when qc_penalty is zero", () => {
    const qcSummary = makeQcSummary({ weighted_open_score: 0, qc_penalty: 0 });
    const report = generateRunReport(baseReportData({ qcSummary }));
    expect(report).toContain("| **SOL score impact** | none");
  });

  it("renders header and QC tables with valid markdown rows", () => {
    const report = generateRunReport(baseReportData({ qcSummary: makeQcSummary() }));
    expect(report).toContain("| Field | Value |");
    expect(report).toContain("| ID | Title | Commit | Status |");
    expect(report).toContain("| Status | Count |");
    expect(report).toContain("| Provider | Total | Blocking | Unvalidated |");
  });

  it("summarizes provider distribution with all children on one provider", () => {
    const telemetryEvents = [
      {
        event: "child-dispatched",
        run_id: "test-run-001",
        child_id: "POL-001",
        provider: "devin",
        routing_summary: {
          selected_provider: "devin",
          selected_adapter: "terminal-cli",
          selection_reason: "role-policy",
          effective_policy_order: ["devin"],
          compatibility_mode: true,
          registry_present: false,
          fallback_eligible: false,
        },
      },
      {
        event: "child-complete",
        run_id: "test-run-001",
        child_id: "POL-001",
        provider: "devin",
        routing_summary: {
          selected_provider: "devin",
          selected_adapter: "terminal-cli",
          selection_reason: "role-policy",
          effective_policy_order: ["devin"],
          compatibility_mode: true,
          registry_present: false,
          fallback_eligible: false,
        },
      },
      {
        event: "child-dispatched",
        run_id: "test-run-001",
        child_id: "POL-002",
        provider: "devin",
        routing_summary: {
          selected_provider: "devin",
          selected_adapter: "terminal-cli",
          selection_reason: "role-policy",
          effective_policy_order: ["devin"],
          compatibility_mode: true,
          registry_present: false,
          fallback_eligible: false,
        },
      },
    ];

    const report = generateRunReport(baseReportData({ telemetryEvents }));
    expect(report).toContain("## Provider routing");
    expect(report).toContain("| POL-001 | — | devin | role-policy | compatibility | devin | — | 0 | Done |");
    expect(report).toContain("| POL-002 | — | devin | role-policy | compatibility | devin | — | 0 | Done |");
    expect(report).toContain("**Provider summary:** devin: 2");
    expect(report).toContain("No routing anomalies or evidence gaps detected.");
  });

  it("summarizes full router candidate evidence with fallback counts", () => {
    const telemetryEvents = [
      {
        event: "provider-selected",
        run_id: "test-run-001",
        child_id: "POL-001",
        selected_provider: "devin",
        selection_reason: "policy-router",
        router_mode: "direct-worker",
        router_compatibility_mode: false,
        providers_tried: ["devin", "copilot"],
        router_candidates: [
          { provider: "devin", adapter: "terminal-cli", score: 0.9, fallback_eligible: true },
          { provider: "copilot", adapter: "terminal-cli", score: 0.7, fallback_eligible: true },
        ],
        routing_summary: {
          selected_provider: "devin",
          selected_adapter: "terminal-cli",
          selection_reason: "policy-router",
          effective_policy_order: ["devin", "copilot"],
          compatibility_mode: false,
          registry_present: true,
          fallback_eligible: true,
        },
      },
      {
        event: "provider-selected",
        run_id: "test-run-001",
        child_id: "POL-002",
        selected_provider: "devin",
        selection_reason: "policy-router",
        router_mode: "direct-worker",
        router_compatibility_mode: false,
        providers_tried: ["copilot", "codex", "devin"],
        router_candidates: [
          { provider: "devin", adapter: "terminal-cli", score: 0.9, fallback_eligible: true },
          { provider: "copilot", adapter: "terminal-cli", score: 0.7, fallback_eligible: true },
          { provider: "codex", adapter: "terminal-cli", score: 0.6, fallback_eligible: false },
        ],
        fallback_attempts: [
          { provider: "copilot", attempt_index: 1, outcome: "rejected", rejection_reasons: ["cost-policy"] },
          { provider: "codex", attempt_index: 2, outcome: "rejected", rejection_reasons: ["no-slot"] },
          { provider: "devin", attempt_index: 3, outcome: "selected", rejection_reasons: [] },
        ],
        routing_summary: {
          selected_provider: "devin",
          selected_adapter: "terminal-cli",
          selection_reason: "policy-router",
          effective_policy_order: ["copilot", "codex", "devin"],
          compatibility_mode: false,
          registry_present: true,
          fallback_eligible: true,
        },
      },
      {
        event: "provider-fallback-attempted",
        run_id: "test-run-001",
        child_id: "POL-002",
        fallback_from: "copilot",
        fallback_reason: "cost-policy",
        fallback_to: "codex",
      },
      {
        event: "child-complete",
        run_id: "test-run-001",
        child_id: "POL-002",
        completion_status: "done",
      },
    ];

    const state = {
      ...minimalState(),
      completed_children: ["POL-002"],
      open_children: ["POL-001"],
    };

    const report = generateRunReport(baseReportData({ state, telemetryEvents }));
    expect(report).toContain("## Provider routing");
    expect(report).toContain("| POL-001 | — | devin | policy-router | router | devin, copilot | 2 | 0 | Open |");
    expect(report).toContain("| POL-002 | — | devin | policy-router | router | copilot, codex, devin | 3 | 2 | Done |");
    expect(report).toContain("**Provider summary:** devin: 2");
    expect(report).toContain("Fallback attempts: 1 (1 successful)");
    expect(report).toContain("Provider monopoly (repeated same-provider selection):");
    expect(report).toContain("devin: 2 occurrence(s) — children: POL-001, POL-002");
    expect(report).not.toContain("missing-child-completion");
  });

  it("calls out missing registry metadata and routing anomalies", () => {
    const telemetryEvents = [
      {
        event: "provider-selected",
        run_id: "test-run-001",
        child_id: "POL-001",
        selected_provider: "devin",
        selection_reason: "policy-router",
        router_compatibility_mode: false,
        providers_tried: ["devin", "copilot"],
        routing_summary: { registry_present: true },
      },
      {
        event: "stale-dispatch-aborted",
        run_id: "test-run-001",
        child_id: "POL-001",
        reason: "POL-494",
        aborted_dispatch_id: "59dad3bd-2638-4991-9509-0e2478c4c34f",
      },
      {
        event: "sealed-result-read-error",
        run_id: "test-run-001",
        child_id: "POL-002",
      },
    ];

    const state = {
      ...minimalState(),
      completed_children: ["POL-001"],
      open_children: ["POL-002"],
    };

    const report = generateRunReport(baseReportData({ state, telemetryEvents }));
    expect(report).toContain("## Provider routing");
    expect(report).toContain("Evidence gaps:");
    expect(report).toContain("missing-router-candidates");
    expect(report).toContain("State repair / runtime review signals:");
    expect(report).toContain("stale-dispatch-abort");
    expect(report).toContain("missing-sealed-result");
  });
});
