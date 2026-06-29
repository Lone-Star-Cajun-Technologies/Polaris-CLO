/**
 * Unit tests for the autoresearch scoring pipeline.
 *
 * Covers:
 * - Dev gate: isPolarisDevContext (pass/fail)
 * - Each of the 8 binary gates: pass, fail, skip
 * - computeScore: empty, all-pass, all-fail, mixed, all-skip
 * - buildDiagnosisHints: presence and shape of hints
 * - Output schema: DiagnosisReport has required fields
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
} from "./gates.js";
import { computeScore, buildDiagnosisHints, scoreRun, loadRunArtifacts } from "./score.js";
import type { RunArtifacts } from "./score.js";
import type { GateResult } from "./gates.js";

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

  it("fails when dispatch_epoch=3", () => {
    const artifacts = emptyArtifacts({
      currentState: { dispatch_boundary: { dispatch_epoch: 3, continue_epoch: 2 } },
    });
    const result = gateForemanResentPacket(artifacts);
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("dispatch_epoch=3");
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

  it("returns hints for all 8 v1 gates", () => {
    const gates = [
      "user-intervened",
      "foreman-resent-packet",
      "foreman-fixed-worker-output",
      "worker-output-required-fixing",
      "validation-failed",
      "worker-went-out-of-scope",
      "foreman-token-burn-over-budget",
      "state-repair-required",
    ];
    const hints = buildDiagnosisHints(gates);
    expect(hints).toHaveLength(8);
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
  });

  it("gate_results contains exactly 8 entries (one per v1 gate)", () => {
    const dir = join(tmpdir(), `polaris-score-gates-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@lsctech/polaris" }));

    const report = scoreRun(dir, "test-run-nonexistent-gates");
    expect(report.gate_results).toHaveLength(8);
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
