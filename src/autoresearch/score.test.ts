/**
 * Unit tests for the autoresearch scoring pipeline.
 *
 * Covers:
 * - Dev gate: isPolarisDevContext (pass/fail)
 * - Each of the 9 binary gates: pass, fail, skip
 * - computeScore: empty, all-pass, all-fail, mixed, all-skip
 * - buildDiagnosisHints: presence and shape of hints
 * - Output schema: DiagnosisReport has required fields
 * - QC artifact loading and computeQcSummary
 * - gateQcBlockingFindings
 */

import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPolarisDevContext, assertPolarisDevContext } from "./dev-gate.js";
import {
  gateUserIntervened,
  gateForemanResentPacket,
  gateForemanFixedWorkerOutput,
  gateWorkerOutputRequiredFixing,
  gateValidationFailed,
  gateWorkerWentOutOfScope,
  gateForemanTokenBurnOverBudget,
  gateStateRepairRequired,
  gateQcBlockingFindings,
} from "./gates.js";
import { computeScore, buildDiagnosisHints, scoreRun, loadRunArtifacts, summarizeRouterOutcomes, computeQcSummary } from "./score.js";
import type { RunArtifacts } from "./score.js";
import type { GateResult } from "./gates.js";
import type { QcResult } from "../qc/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function emptyArtifacts(overrides: Partial<RunArtifacts> = {}): RunArtifacts {
  return {
    runId: "test-run-001",
    runDir: null,
    clusterDir: null,
    currentState: null,
    ledgerEvents: [],
    resultPackets: [],
    workerResultContracts: [],
    telemetryEvents: [],
    qcResults: [],
    ...overrides,
  };
}

function makeQcResult(overrides: Partial<QcResult> & { findings?: QcResult["findings"] } = {}): QcResult {
  return {
    schemaVersion: "1.0",
    qcRunId: `qc-run-${Date.now()}`,
    runId: "test-run-001",
    clusterId: "POL-000",
    trigger: "completed-cluster",
    provider: "test-provider",
    providerMode: "local",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "findings",
    findings: [],
    rawArtifactPaths: [],
    parserVersion: "1.0",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: false,
      routedToRepair: false,
      summary: "test",
    },
    ...overrides,
  };
}

// ── Dev gate ─────────────────────────────────────────────────────────────────

describe("isPolarisDevContext", () => {
  it("returns true when package.json has name @lsctech/polaris", () => {
    const dir = join(tmpdir(), `polaris-dev-gate-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lsctech/polaris" }));
    expect(isPolarisDevContext(dir)).toBe(true);
  });

  it("returns false when package.json has a different name", () => {
    const dir = join(tmpdir(), `polaris-dev-gate-test-other-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "some-other-package" }));
    expect(isPolarisDevContext(dir)).toBe(false);
  });

  it("returns false when no package.json exists", () => {
    const dir = join(tmpdir(), `polaris-dev-gate-no-pkg-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // deliberately no package.json
    // traverse will hit OS root and return false
    expect(isPolarisDevContext(dir)).toBe(false);
  });
});

describe("assertPolarisDevContext", () => {
  it("throws outside dev context", () => {
    const dir = join(tmpdir(), `polaris-dev-gate-throw-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "not-polaris" }));
    expect(() => assertPolarisDevContext(dir)).toThrow(/dev-only command/);
  });

  it("does not throw inside dev context", () => {
    const dir = join(tmpdir(), `polaris-dev-gate-ok-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lsctech/polaris" }));
    expect(() => assertPolarisDevContext(dir)).not.toThrow();
  });
});

// ── Gate: user-intervened ─────────────────────────────────────────────────────

describe("gateUserIntervened", () => {
  it("skips when no contracts present", () => {
    expect(gateUserIntervened(emptyArtifacts()).outcome).toBe("skipped");
  });

  it("passes when user_intervened=false", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ user_intervened: false } as never],
    });
    expect(gateUserIntervened(artifacts).outcome).toBe("passed");
  });

  it("fails when user_intervened=true", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ user_intervened: true } as never],
    });
    expect(gateUserIntervened(artifacts).outcome).toBe("failed");
  });

  it("skips when user_intervened=null", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ user_intervened: null } as never],
    });
    expect(gateUserIntervened(artifacts).outcome).toBe("skipped");
  });
});

// ── Gate: foreman-resent-packet ───────────────────────────────────────────────

describe("gateForemanResentPacket", () => {
  it("skips when no current state", () => {
    expect(gateForemanResentPacket(emptyArtifacts()).outcome).toBe("skipped");
  });

  it("passes when dispatch_epoch=1", () => {
    const artifacts = emptyArtifacts({
      currentState: { dispatch_boundary: { dispatch_epoch: 1, continue_epoch: 0 } },
    });
    expect(gateForemanResentPacket(artifacts).outcome).toBe("passed");
  });

  it("skips when dispatch_epoch>1 but per-child dispatch data is unavailable", () => {
    const artifacts = emptyArtifacts({
      currentState: { dispatch_boundary: { dispatch_epoch: 3, continue_epoch: 2 } },
    });
    const result = gateForemanResentPacket(artifacts);
    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("per-child dispatch count data unavailable");
  });

  it("passes when multi-epoch with distinct children", () => {
    const artifacts = emptyArtifacts({
      currentState: { dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1 } },
      ledgerEvents: [
        { event: "child-dispatched", issue_id: "POL-422", dispatch_epoch: 1 },
        { event: "child-dispatched", issue_id: "POL-423", dispatch_epoch: 2 },
      ],
    });
    expect(gateForemanResentPacket(artifacts).outcome).toBe("passed");
  });

  it("fails when a child is re-dispatched", () => {
    const artifacts = emptyArtifacts({
      currentState: { dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1 } },
      ledgerEvents: [
        { event: "child-dispatched", issue_id: "POL-422", dispatch_epoch: 1 },
        { event: "child-dispatched", issue_id: "POL-422", dispatch_epoch: 2 },
      ],
    });
    const result = gateForemanResentPacket(artifacts);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("POL-422");
  });

  it("detects re-dispatch from telemetry child-dispatched events", () => {
    const artifacts = emptyArtifacts({
      currentState: { dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1 } },
      telemetryEvents: [
        { event: "child-dispatched", child_id: "POL-422" },
        { event: "child-dispatched", child_id: "POL-422" },
      ],
    });
    const result = gateForemanResentPacket(artifacts);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("POL-422");
  });

  it("detects re-dispatch from open_children_meta dispatch_count", () => {
    const artifacts = emptyArtifacts({
      currentState: {
        dispatch_boundary: { dispatch_epoch: 2, continue_epoch: 1 },
        open_children_meta: {
          "POL-422": {
            dispatch_record: { dispatch_count: 2 },
          },
        },
      },
    });
    const result = gateForemanResentPacket(artifacts);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("POL-422");
  });

  it("skips when dispatch_boundary is absent", () => {
    const artifacts = emptyArtifacts({ currentState: { run_id: "test" } });
    expect(gateForemanResentPacket(artifacts).outcome).toBe("skipped");
  });
});

// ── Gate: foreman-fixed-worker-output ─────────────────────────────────────────

describe("gateForemanFixedWorkerOutput", () => {
  it("skips when no contracts", () => {
    expect(gateForemanFixedWorkerOutput(emptyArtifacts()).outcome).toBe("skipped");
  });

  it("passes when foreman_intervened=false", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ foreman_intervened: false } as never],
    });
    expect(gateForemanFixedWorkerOutput(artifacts).outcome).toBe("passed");
  });

  it("fails when foreman_intervened=true", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ foreman_intervened: true } as never],
    });
    expect(gateForemanFixedWorkerOutput(artifacts).outcome).toBe("failed");
  });
});

// ── Gate: worker-output-required-fixing ───────────────────────────────────────

describe("gateWorkerOutputRequiredFixing", () => {
  it("skips when no ledger finalized event and no intervention flags", () => {
    const result = gateWorkerOutputRequiredFixing(emptyArtifacts());
    expect(result.outcome).toBe("skipped");
  });

  it("fails when user_intervened=true in any contract", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ user_intervened: true, foreman_intervened: false } as never],
    });
    expect(gateWorkerOutputRequiredFixing(artifacts).outcome).toBe("failed");
  });

  it("fails when foreman_intervened=true in any contract", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ user_intervened: false, foreman_intervened: true } as never],
    });
    expect(gateWorkerOutputRequiredFixing(artifacts).outcome).toBe("failed");
  });

  it("passes when finalized event exists and no interventions", () => {
    const artifacts = emptyArtifacts({
      workerResultContracts: [{ user_intervened: false, foreman_intervened: false } as never],
      ledgerEvents: [{ event: "finalized", run_id: "test-run-001" }],
    });
    expect(gateWorkerOutputRequiredFixing(artifacts).outcome).toBe("passed");
  });
});

// ── Gate: validation-failed ────────────────────────────────────────────────────

describe("gateValidationFailed", () => {
  it("skips when no result packets", () => {
    expect(gateValidationFailed(emptyArtifacts()).outcome).toBe("skipped");
  });

  it("passes when result has validation.passed=[...]", () => {
    const artifacts = emptyArtifacts({
      resultPackets: [{ status: "success", validation: { passed: ["npm run build"] } }],
    });
    expect(gateValidationFailed(artifacts).outcome).toBe("passed");
  });

  it("fails when all results have status=failure", () => {
    const artifacts = emptyArtifacts({
      resultPackets: [{ status: "failure", error_message: "build failed" }],
    });
    expect(gateValidationFailed(artifacts).outcome).toBe("failed");
  });

  it("fails when validation is missing from a result", () => {
    const artifacts = emptyArtifacts({
      resultPackets: [{ status: "success" }],
    });
    expect(gateValidationFailed(artifacts).outcome).toBe("failed");
  });

  it("passes when validation string is 'passed'", () => {
    const artifacts = emptyArtifacts({
      resultPackets: [{ status: "success", validation: "passed" }],
    });
    // "passed" string matches pass path
    const result = gateValidationFailed(artifacts);
    expect(result.outcome).toBe("passed");
  });
});

// ── Gate: worker-went-out-of-scope ─────────────────────────────────────────────

describe("gateWorkerWentOutOfScope", () => {
  it("skips when no telemetry or result packets", () => {
    expect(gateWorkerWentOutOfScope(emptyArtifacts()).outcome).toBe("skipped");
  });

  it("fails when worker-blocked with out-of-scope in telemetry", () => {
    const artifacts = emptyArtifacts({
      telemetryEvents: [
        { event: "worker-blocked", approval_type: "out-of-scope", run_id: "test-run-001" },
      ],
    });
    expect(gateWorkerWentOutOfScope(artifacts).outcome).toBe("failed");
  });

  it("fails when result packet status=blocked", () => {
    const artifacts = emptyArtifacts({
      resultPackets: [{ status: "blocked", child_id: "POL-001" }],
    });
    expect(gateWorkerWentOutOfScope(artifacts).outcome).toBe("failed");
  });

  it("passes when telemetry present but no out-of-scope blocks", () => {
    const artifacts = emptyArtifacts({
      telemetryEvents: [{ event: "worker-heartbeat", run_id: "test-run-001" }],
      resultPackets: [{ status: "success", validation: { passed: ["build"] } }],
    });
    expect(gateWorkerWentOutOfScope(artifacts).outcome).toBe("passed");
  });
});

// ── Gate: foreman-token-burn-over-budget ──────────────────────────────────────

describe("gateForemanTokenBurnOverBudget", () => {
  it("skips when no bootstrap-context-size events", () => {
    const artifacts = emptyArtifacts({
      telemetryEvents: [{ event: "worker-heartbeat" }],
    });
    expect(gateForemanTokenBurnOverBudget(artifacts).outcome).toBe("skipped");
  });

  it("passes when combined tokens are under threshold", () => {
    const artifacts = emptyArtifacts({
      telemetryEvents: [
        { event: "bootstrap-context-size", combined_estimated_tokens: 50_000 },
      ],
    });
    expect(gateForemanTokenBurnOverBudget(artifacts).outcome).toBe("passed");
  });

  it("fails when combined tokens exceed 150k", () => {
    const artifacts = emptyArtifacts({
      telemetryEvents: [
        { event: "bootstrap-context-size", combined_estimated_tokens: 200_000 },
      ],
    });
    const result = gateForemanTokenBurnOverBudget(artifacts);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("200000");
  });
});

// ── Gate: state-repair-required ────────────────────────────────────────────────

describe("gateStateRepairRequired", () => {
  it("skips when clusterDir is null", () => {
    expect(gateStateRepairRequired(emptyArtifacts()).outcome).toBe("skipped");
  });

  describe("summarizeRouterOutcomes", () => {
    it("counts successful fallback without classifying it as a recurring failure", () => {
      const artifacts = emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-selected",
            child_id: "POL-100",
            selected_provider: "codex",
            providers_tried: ["copilot", "codex"],
            fallback_attempts: [
              { provider: "copilot", attempt_index: 1, outcome: "rejected", rejection_reasons: ["quota-exhausted"] },
              { provider: "codex", attempt_index: 2, outcome: "selected", rejection_reasons: [] },
            ],
          },
          {
            event: "provider-fallback-attempted",
            child_id: "POL-100",
            fallback_from: "copilot",
            fallback_reason: "quota-exhausted",
            fallback_to: "codex",
          },
          {
            event: "child-complete",
            child_id: "POL-100",
            completion_status: "done",
          },
        ],
      });

      const summary = summarizeRouterOutcomes(artifacts);
      expect(summary.total_decisions).toBe(1);
      expect(summary.fallback_attempts).toBe(1);
      expect(summary.successful_fallbacks).toBe(1);
      expect(summary.recurring_failures).toEqual([]);
    });

    it("aggregates recurring quota/trust/capability router failures", () => {
      const artifacts = emptyArtifacts({
        telemetryEvents: [
          {
            event: "provider-exhausted",
            child_id: "POL-101",
            reason: "quota-exhausted",
          },
          {
            event: "provider-selected",
            child_id: "POL-102",
            selected_provider: null,
            router_exhausted_reason: "trust-too-low",
            router_candidates: [
              { provider: "copilot", eligible: false, rejection_reasons: ["trust-too-low"] },
            ],
          },
          {
            event: "provider-selected",
            child_id: "POL-103",
            selected_provider: null,
            router_exhausted_reason: "capability-mismatch",
            router_candidates: [
              { provider: "copilot", eligible: false, rejection_reasons: ["capability-mismatch"] },
            ],
          },
        ],
      });

      const summary = summarizeRouterOutcomes(artifacts);
      expect(summary.exhausted_decisions).toBe(1);
      expect(summary.recurring_failures.some((failure) => failure.reason === "quota-exhausted")).toBe(true);
      expect(summary.recurring_failures.some((failure) => failure.reason === "trust-too-low")).toBe(true);
      expect(summary.recurring_failures.some((failure) => failure.reason === "capability-mismatch")).toBe(true);
    });
  });

  it("passes when cluster dir has no medic artifacts", () => {
    const dir = join(tmpdir(), `polaris-cluster-clean-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cluster-state.json"), JSON.stringify({ schema_version: "1.0" }));
    const artifacts = emptyArtifacts({ clusterDir: dir });
    expect(gateStateRepairRequired(artifacts).outcome).toBe("passed");
  });

  it("fails when a CHART- file is present in cluster dir", () => {
    const dir = join(tmpdir(), `polaris-cluster-medic-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CHART-001-abc.json"), JSON.stringify({ status: "partial" }));
    const artifacts = emptyArtifacts({ clusterDir: dir });
    expect(gateStateRepairRequired(artifacts).outcome).toBe("failed");
  });

  it("fails when a medic-result- file is in results subdir", () => {
    const dir = join(tmpdir(), `polaris-cluster-medic-results-${Date.now()}`);
    const resultsDir = join(dir, "results");
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(resultsDir, "medic-result-abc.json"), JSON.stringify({ status: "success" }));
    const artifacts = emptyArtifacts({ clusterDir: dir });
    expect(gateStateRepairRequired(artifacts).outcome).toBe("failed");
  });
});

// ── loadRunArtifacts ──────────────────────────────────────────────────────────

describe("loadRunArtifacts", () => {
  it("extracts workerResultContracts from completed_children_results in current-state.json", () => {
    const dir = join(tmpdir(), `polaris-lra-state-${Date.now()}`);
    const runsDir = join(dir, ".taskchain_artifacts", "polaris-run", "runs", "test-run-state");
    mkdirSync(runsDir, { recursive: true });
    const contract = {
      child_id: "POL-001",
      run_id: "test-run-state",
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
      heartbeat_count: 3,
      result_artifact_path: "/fake/path",
      packet_path: "/fake/packet",
      telemetry_path: "/fake/telemetry",
      user_intervened: null,
      foreman_intervened: null,
    };
    writeFileSync(
      join(runsDir, "current-state.json"),
      JSON.stringify({
        run_id: "test-run-state",
        cluster_id: "POL-000",
        completed_children_results: { "POL-001": contract },
      }),
    );
    const artifacts = loadRunArtifacts(dir, "test-run-state");
    expect(artifacts.workerResultContracts).toHaveLength(1);
    expect(artifacts.workerResultContracts[0].child_id).toBe("POL-001");
    expect(artifacts.workerResultContracts[0].worker_id).toBe("worker-001");
  });

  it("falls back to extractWorkerResultContracts from result packets when completed_children_results is absent", () => {
    const dir = join(tmpdir(), `polaris-lra-fallback-${Date.now()}`);
    const clusterResultsDir = join(dir, ".polaris", "clusters", "POL-000", "results");
    mkdirSync(clusterResultsDir, { recursive: true });
    const taskchainStateDir = join(dir, ".taskchain_artifacts", "polaris-run");
    mkdirSync(taskchainStateDir, { recursive: true });
    // State without completed_children_results
    writeFileSync(
      join(taskchainStateDir, "current-state.json"),
      JSON.stringify({ run_id: "test-run-fallback", cluster_id: "POL-000" }),
    );
    // Legacy result file with worker_id field
    const legacyContract = { child_id: "POL-002", worker_id: "worker-002", packet_hash: "hash2" };
    writeFileSync(join(clusterResultsDir, "POL-002-abc.json"), JSON.stringify(legacyContract));
    const artifacts = loadRunArtifacts(dir, "test-run-fallback");
    expect(artifacts.workerResultContracts).toHaveLength(1);
    expect(artifacts.workerResultContracts[0].worker_id).toBe("worker-002");
  });

  it("excludes librarian, CHART, and medic-result files from resultPackets", () => {
    const dir = join(tmpdir(), `polaris-lra-filter-${Date.now()}`);
    const clusterResultsDir = join(dir, ".polaris", "clusters", "POL-000", "results");
    mkdirSync(clusterResultsDir, { recursive: true });
    const taskchainStateDir = join(dir, ".taskchain_artifacts", "polaris-run");
    mkdirSync(taskchainStateDir, { recursive: true });
    writeFileSync(
      join(taskchainStateDir, "current-state.json"),
      JSON.stringify({ run_id: "test-run-filter", cluster_id: "POL-000" }),
    );
    // Worker result — should be included
    writeFileSync(
      join(clusterResultsDir, "POL-003-def.json"),
      JSON.stringify({ child_id: "POL-003", status: "success", validation: { passed: ["build"] } }),
    );
    // Non-worker artifacts — should be excluded
    writeFileSync(join(clusterResultsDir, "librarian-uuid.json"), JSON.stringify({ role: "librarian" }));
    writeFileSync(join(clusterResultsDir, "CHART-uuid.json"), JSON.stringify({ role: "chart" }));
    writeFileSync(join(clusterResultsDir, "medic-result-uuid.json"), JSON.stringify({ role: "medic" }));

    const artifacts = loadRunArtifacts(dir, "test-run-filter");
    expect(artifacts.resultPackets).toHaveLength(1);
    const packet = artifacts.resultPackets[0] as Record<string, unknown>;
    expect(packet["child_id"]).toBe("POL-003");
  });
});

// ── computeScore ──────────────────────────────────────────────────────────────

describe("computeScore", () => {
  it("returns 1.0 when no evaluable gates (all skipped)", () => {
    const gates: GateResult[] = [
      { gate: "a", outcome: "skipped" },
      { gate: "b", outcome: "skipped" },
    ];
    expect(computeScore(gates)).toBe(1.0);
  });

  it("returns 1.0 when all gates pass", () => {
    const gates: GateResult[] = [
      { gate: "a", outcome: "passed" },
      { gate: "b", outcome: "passed" },
    ];
    expect(computeScore(gates)).toBe(1.0);
  });

  it("returns 0.0 when all gates fail", () => {
    const gates: GateResult[] = [
      { gate: "a", outcome: "failed" },
      { gate: "b", outcome: "failed" },
    ];
    expect(computeScore(gates)).toBe(0.0);
  });

  it("returns 0.5 for 2 pass, 2 fail", () => {
    const gates: GateResult[] = [
      { gate: "a", outcome: "passed" },
      { gate: "b", outcome: "passed" },
      { gate: "c", outcome: "failed" },
      { gate: "d", outcome: "failed" },
    ];
    expect(computeScore(gates)).toBe(0.5);
  });

  it("ignores skipped gates in denominator", () => {
    const gates: GateResult[] = [
      { gate: "a", outcome: "passed" },
      { gate: "b", outcome: "skipped" },
      { gate: "c", outcome: "failed" },
    ];
    // 1 passed / 2 evaluable = 0.5
    expect(computeScore(gates)).toBe(0.5);
  });
});

// ── buildDiagnosisHints ────────────────────────────────────────────────────────

describe("buildDiagnosisHints", () => {
  it("returns empty array for no failed gates", () => {
    expect(buildDiagnosisHints([])).toEqual([]);
  });

  it("returns hint with fix_zone and hint for known gate", () => {
    const hints = buildDiagnosisHints(["validation-failed"]);
    expect(hints).toHaveLength(1);
    expect(hints[0].gate).toBe("validation-failed");
    expect(typeof hints[0].fix_zone).toBe("string");
    expect(hints[0].fix_zone.length).toBeGreaterThan(0);
    expect(typeof hints[0].hint).toBe("string");
    expect(hints[0].hint.length).toBeGreaterThan(0);
  });

  it("returns fallback hint for unknown gate", () => {
    const hints = buildDiagnosisHints(["unknown-gate-xyz"]);
    expect(hints).toHaveLength(1);
    expect(hints[0].fix_zone).toBe("unknown");
    expect(hints[0].hint).toContain("unknown-gate-xyz");
  });

  it("returns hints for all 9 gates (8 v1 + qc-blocking-findings)", () => {
    const gates = [
      "user-intervened",
      "foreman-resent-packet",
      "foreman-fixed-worker-output",
      "worker-output-required-fixing",
      "validation-failed",
      "worker-went-out-of-scope",
      "foreman-token-burn-over-budget",
      "state-repair-required",
      "qc-blocking-findings",
    ];
    const hints = buildDiagnosisHints(gates);
    expect(hints).toHaveLength(9);
    for (const hint of hints) {
      expect(hint.fix_zone).not.toBe("unknown");
    }
  });
});

// ── Output schema (DiagnosisReport) ──────────────────────────────────────────

describe("scoreRun output schema", () => {
  it("returns a valid DiagnosisReport with all required fields", () => {
    const dir = join(tmpdir(), `polaris-score-schema-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // Minimal package.json so dev gate passes
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lsctech/polaris" }));

    const report = scoreRun(dir, "test-run-nonexistent");

    expect(typeof report.run_id).toBe("string");
    expect(typeof report.evaluated_at).toBe("string");
    expect(Array.isArray(report.gate_results)).toBe(true);
    expect(Array.isArray(report.failed_gates)).toBe(true);
    expect(typeof report.score).toBe("number");
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(1);
    expect(Array.isArray(report.diagnosis_hints)).toBe(true);
    expect(typeof report.router_outcomes).toBe("object");
    expect(typeof report.router_outcomes.total_decisions).toBe("number");
    // qc_summary is null when no QC artifacts exist
    expect(report.qc_summary).toBeNull();
  });

  it("gate_results contains exactly 9 entries (8 v1 gates + qc-blocking-findings)", () => {
    const dir = join(tmpdir(), `polaris-score-gates-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lsctech/polaris" }));

    const report = scoreRun(dir, "test-run-nonexistent-gates");
    expect(report.gate_results).toHaveLength(9);
  });

  it("each gate_result has gate, outcome fields", () => {
    const dir = join(tmpdir(), `polaris-score-fields-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lsctech/polaris" }));

    const report = scoreRun(dir, "test-run-nonexistent-fields");
    for (const gr of report.gate_results) {
      expect(typeof gr.gate).toBe("string");
      expect(["passed", "failed", "skipped"]).toContain(gr.outcome);
    }
  });
});

// ── computeQcSummary ──────────────────────────────────────────────────────────

describe("computeQcSummary", () => {
  it("returns null when qcResults is empty", () => {
    expect(computeQcSummary([])).toBeNull();
  });

  it("returns zero-counts when QC result has no findings", () => {
    const result = computeQcSummary([makeQcResult()]);
    expect(result).not.toBeNull();
    expect(result!.total_findings).toBe(0);
    expect(result!.blocking_findings).toBe(0);
    expect(result!.qc_run_count).toBe(1);
    expect(result!.blocks_delivery).toBe(false);
  });

  it("counts blocking findings (critical/high, open, high/medium confidence)", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "critical",
        title: "SQL injection",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
      },
      {
        findingId: "f2",
        severity: "high",
        title: "XSS",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "medium", reason: "changed-file-owner" },
        status: "follow-up",
      },
    ];
    const result = computeQcSummary([makeQcResult({ findings })]);
    expect(result!.blocking_findings).toBe(2);
    expect(result!.total_findings).toBe(2);
    expect(result!.open_by_severity.critical).toBe(1);
    expect(result!.open_by_severity.high).toBe(1);
  });

  it("does not count low-attribution findings as blocking (provider noise)", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "critical",
        title: "Noise",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "low", reason: "provider-uncertain" },
        status: "open",
      },
      {
        findingId: "f2",
        severity: "high",
        title: "Unattributed",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "unattributed", reason: "unattributed" },
        status: "open",
      },
    ];
    const result = computeQcSummary([makeQcResult({ findings })]);
    expect(result!.blocking_findings).toBe(0);
    expect(result!.unvalidated_findings).toBe(2);
    expect(result!.open_by_severity.critical).toBe(0);
    expect(result!.open_by_severity.high).toBe(0);
  });

  it("does not count autofixed/repaired/waived as blocking", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "critical",
        title: "Autofixed",
        fixAvailable: true,
        autofixEligible: true,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "autofixed",
      },
      {
        findingId: "f2",
        severity: "high",
        title: "Repaired",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "repaired",
      },
      {
        findingId: "f3",
        severity: "critical",
        title: "Waived",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "medium", reason: "changed-file-owner" },
        status: "waived",
      },
    ];
    const result = computeQcSummary([makeQcResult({ findings })]);
    expect(result!.blocking_findings).toBe(0);
    expect(result!.autofixed_findings).toBe(1);
    expect(result!.repaired_findings).toBe(1);
    expect(result!.waived_findings).toBe(1);
  });

  it("surfaces blocks_delivery from policyDecision", () => {
    const result = computeQcSummary([
      makeQcResult({
        policyDecision: {
          blocksDelivery: true,
          requiresOperatorReview: false,
          routedToRepair: false,
          summary: "blocked",
        },
      }),
    ]);
    expect(result!.blocks_delivery).toBe(true);
  });

  it("aggregates findings across multiple QC runs", () => {
    const findingA: QcResult["findings"] = [
      {
        findingId: "fa1",
        severity: "medium",
        title: "Medium finding",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
      },
    ];
    const findingB: QcResult["findings"] = [
      {
        findingId: "fb1",
        severity: "low",
        title: "Low finding",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "medium", reason: "child-scope-match" },
        status: "open",
      },
    ];
    const result = computeQcSummary([
      makeQcResult({ findings: findingA }),
      makeQcResult({ findings: findingB }),
    ]);
    expect(result!.total_findings).toBe(2);
    expect(result!.qc_run_count).toBe(2);
    expect(result!.open_by_severity.medium).toBe(1);
    expect(result!.open_by_severity.low).toBe(1);
  });
});

// ── gateQcBlockingFindings ────────────────────────────────────────────────────

describe("gateQcBlockingFindings", () => {
  it("skips when no QC results exist", () => {
    const result = gateQcBlockingFindings(emptyArtifacts());
    expect(result.outcome).toBe("skipped");
  });

  it("passes when QC results exist but no blocking findings", () => {
    const artifacts = emptyArtifacts({ qcResults: [makeQcResult()] });
    const result = gateQcBlockingFindings(artifacts);
    expect(result.outcome).toBe("passed");
  });

  it("passes when critical findings are all autofixed", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "critical",
        title: "Autofixed critical",
        fixAvailable: true,
        autofixEligible: true,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "autofixed",
      },
    ];
    const artifacts = emptyArtifacts({ qcResults: [makeQcResult({ findings })] });
    expect(gateQcBlockingFindings(artifacts).outcome).toBe("passed");
  });

  it("passes when critical findings have low/unattributed confidence (provider noise)", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "critical",
        title: "Noisy critical",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "low", reason: "provider-uncertain" },
        status: "open",
      },
    ];
    const artifacts = emptyArtifacts({ qcResults: [makeQcResult({ findings })] });
    expect(gateQcBlockingFindings(artifacts).outcome).toBe("passed");
  });

  it("fails when unresolved critical finding with high confidence", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "critical",
        title: "Open critical",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
      },
    ];
    const artifacts = emptyArtifacts({ qcResults: [makeQcResult({ findings })] });
    const result = gateQcBlockingFindings(artifacts);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("1 unresolved critical/high");
  });

  it("fails when unresolved high finding with medium confidence", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "high",
        title: "Open high",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "medium", reason: "changed-file-owner" },
        status: "follow-up",
      },
    ];
    const artifacts = emptyArtifacts({ qcResults: [makeQcResult({ findings })] });
    expect(gateQcBlockingFindings(artifacts).outcome).toBe("failed");
  });

  it("passes when medium finding with high confidence (not a blocker)", () => {
    const findings: QcResult["findings"] = [
      {
        findingId: "f1",
        severity: "medium",
        title: "Open medium",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
      },
    ];
    const artifacts = emptyArtifacts({ qcResults: [makeQcResult({ findings })] });
    expect(gateQcBlockingFindings(artifacts).outcome).toBe("passed");
  });
});
