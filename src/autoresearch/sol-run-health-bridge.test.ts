/**
 * Tests for SOL → run-health bridge (sol-run-health-bridge.ts).
 *
 * Coverage:
 *   - detectSolThresholdCrossings: each threshold fires correctly
 *   - evaluateSolThresholds: advisory default (no symptoms when disabled)
 *   - evaluateSolThresholds: writes symptoms when policy.createRunHealthReport=true
 *   - evaluateSolThresholds: marks medic pending when policy.requireMedic=true
 *   - evaluateSolThresholds: never throws
 *   - Default threshold values are applied when config fields are absent
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectSolThresholdCrossings,
  evaluateSolThresholds,
} from "./sol-run-health-bridge.js";
import { readRunHealthReport } from "../run-health/index.js";
import type { SolScoreReport, SolForemanScoreReport, SolWorkerScoreReport } from "../types/sol-score.js";
import type { SolThresholdsConfig } from "../config/schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeForeman(overrides: Partial<SolForemanScoreReport> = {}): SolForemanScoreReport {
  return {
    composite_score: 0.8,
    composite_confidence: "high",
    token: { dimension: "token", score: 1.0, confidence: "high" },
    duration: { dimension: "duration", score: 1.0, confidence: "medium" },
    intervention: { dimension: "intervention", score: 1.0, confidence: "high" },
    pre_analysis: { dimension: "pre_analysis", score: 1.0, confidence: "medium", detail: "escalation_events=0" },
    dependency: { dimension: "dependency", score: 1.0, confidence: "medium" },
    dispatch: { dimension: "dispatch", score: 1.0, confidence: "medium", detail: "redispatched=0/3" },
    evidence_validation: { dimension: "evidence_validation", score: 1.0, confidence: "medium" },
    scope: { dimension: "scope", score: 1.0, confidence: "medium" },
    completion: { dimension: "completion", score: 1.0, confidence: "medium" },
    recovery: { dimension: "recovery", score: 1.0, confidence: "low" },
    qc_repair_loop: { dimension: "qc_repair_loop", score: null, confidence: "none", skipped_reason: "no QC repair loop data available" },
    ...overrides,
  };
}

function makeWorker(childId: string, overrides: Partial<SolWorkerScoreReport> = {}): SolWorkerScoreReport {
  return {
    child_id: childId,
    composite_score: 0.8,
    composite_confidence: "high",
    token: { dimension: "token", score: 1.0, confidence: "high" },
    duration: { dimension: "duration", score: 1.0, confidence: "medium" },
    validation: { dimension: "validation", score: 1.0, confidence: "high", detail: "validation=passed" },
    qc: { dimension: "qc", score: null, confidence: "none", skipped_reason: "no per-child QC" },
    repair_iterations: { dimension: "repair_iterations", score: 1.0, confidence: "medium" },
    scope_adherence: { dimension: "scope_adherence", score: 1.0, confidence: "medium" },
    acceptance_criteria: { dimension: "acceptance_criteria", score: 1.0, confidence: "high" },
    first_pass: { dimension: "first_pass", score: 1.0, confidence: "high" },
    ...overrides,
  };
}

function makeScoreReport(overrides: Partial<SolScoreReport> = {}): SolScoreReport {
  return {
    run_id: "test-run-001",
    cluster_id: "POL-TEST",
    scored_at: new Date().toISOString(),
    foreman: makeForeman(),
    workers: { "POL-001": makeWorker("POL-001") },
    run_composite_score: 0.8,
    ...overrides,
  };
}

function enabledThresholds(overrides: Partial<SolThresholdsConfig> = {}): SolThresholdsConfig {
  return {
    enabled: true,
    policy: { createRunHealthReport: true },
    ...overrides,
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-sol-bridge-"));
});

function cleanup() {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* no-op */ }
}

// ── detectSolThresholdCrossings ───────────────────────────────────────────────

describe("detectSolThresholdCrossings: no crossings on clean run", () => {
  it("returns no crossings when all scores are healthy", () => {
    const crossings = detectSolThresholdCrossings(makeScoreReport(), enabledThresholds(), []);
    expect(crossings).toHaveLength(0);
  });
});

describe("detectSolThresholdCrossings: low composite score", () => {
  it("fires sol-low-composite-score when run_composite_score < threshold", () => {
    const report = makeScoreReport({ run_composite_score: 0.3 });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ low_composite_score: 0.4 }), []);
    expect(crossings.some((c) => c.code === "sol-low-composite-score")).toBe(true);
  });

  it("does NOT fire when run_composite_score equals threshold", () => {
    const report = makeScoreReport({ run_composite_score: 0.4 });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ low_composite_score: 0.4 }), []);
    expect(crossings.some((c) => c.code === "sol-low-composite-score")).toBe(false);
  });

  it("does NOT fire when run_composite_score is null (no evidence)", () => {
    const report = makeScoreReport({ run_composite_score: null });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds(), []);
    expect(crossings.some((c) => c.code === "sol-low-composite-score")).toBe(false);
  });

  it("uses default threshold 0.4 when not configured", () => {
    const report = makeScoreReport({ run_composite_score: 0.35 });
    const crossings = detectSolThresholdCrossings(report, { enabled: true }, []);
    expect(crossings.some((c) => c.code === "sol-low-composite-score")).toBe(true);
  });
});

describe("detectSolThresholdCrossings: QC repair-loop failure", () => {
  it("fires sol-qc-repair-loop-failure when qc_repair_loop score is 0", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        qc_repair_loop: { dimension: "qc_repair_loop", score: 0, confidence: "high", detail: "status=medic-referral, failed_packets=2, rerun=n/a" },
      }),
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds(), []);
    expect(crossings.some((c) => c.code === "sol-qc-repair-loop-failure")).toBe(true);
  });

  it("fires sol-qc-repair-loop-failure when detail contains configured status", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        qc_repair_loop: { dimension: "qc_repair_loop", score: 0, confidence: "high", detail: "status=max-rounds, rounds=3/3" },
      }),
    });
    const crossings = detectSolThresholdCrossings(
      report,
      enabledThresholds({ qc_repair_loop_failure_statuses: ["max-rounds"] }),
      [],
    );
    expect(crossings.some((c) => c.code === "sol-qc-repair-loop-failure")).toBe(true);
  });

  it("does NOT fire when qc_repair_loop score is 1.0 (passed)", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        qc_repair_loop: { dimension: "qc_repair_loop", score: 1.0, confidence: "high", detail: "status=passed, rounds=1/3" },
      }),
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds(), []);
    expect(crossings.some((c) => c.code === "sol-qc-repair-loop-failure")).toBe(false);
  });
});

describe("detectSolThresholdCrossings: repeated provider failures", () => {
  it("fires sol-repeated-provider-failures when enough workers score 0", () => {
    const report = makeScoreReport({
      workers: {
        "POL-001": makeWorker("POL-001", { composite_score: 0 }),
        "POL-002": makeWorker("POL-002", { composite_score: 0 }),
        "POL-003": makeWorker("POL-003", { composite_score: 0 }),
      },
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ repeated_provider_failures: 3 }), []);
    expect(crossings.some((c) => c.code === "sol-repeated-provider-failures")).toBe(true);
  });

  it("does NOT fire when fewer workers fail than threshold", () => {
    const report = makeScoreReport({
      workers: {
        "POL-001": makeWorker("POL-001", { composite_score: 0 }),
        "POL-002": makeWorker("POL-002", { composite_score: 0.8 }),
      },
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ repeated_provider_failures: 3 }), []);
    expect(crossings.some((c) => c.code === "sol-repeated-provider-failures")).toBe(false);
  });
});

describe("detectSolThresholdCrossings: foreman intervention count", () => {
  it("fires sol-high-foreman-intervention when escalation_events > threshold", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        intervention: { dimension: "intervention", score: 0, confidence: "high", detail: "user_intervened=true" },
        pre_analysis: { dimension: "pre_analysis", score: 0, confidence: "high", detail: "escalation_events=5" },
      }),
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ foreman_intervention_count: 2 }), []);
    expect(crossings.some((c) => c.code === "sol-high-foreman-intervention")).toBe(true);
  });

  it("does NOT fire when escalation_events <= threshold", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        intervention: { dimension: "intervention", score: 0.5, confidence: "high", detail: "foreman_intervened=true" },
        pre_analysis: { dimension: "pre_analysis", score: 0.5, confidence: "high", detail: "escalation_events=2" },
      }),
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ foreman_intervention_count: 2 }), []);
    expect(crossings.some((c) => c.code === "sol-high-foreman-intervention")).toBe(false);
  });
});

describe("detectSolThresholdCrossings: validation failures", () => {
  it("fires sol-validation-failures when enough workers have validation score 0", () => {
    const report = makeScoreReport({
      workers: {
        "POL-001": makeWorker("POL-001", { validation: { dimension: "validation", score: 0, confidence: "high", detail: "validation=failed" } }),
        "POL-002": makeWorker("POL-002", { validation: { dimension: "validation", score: 0, confidence: "high", detail: "validation=failed" } }),
      },
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ validation_failures: 2 }), []);
    expect(crossings.some((c) => c.code === "sol-validation-failures")).toBe(true);
  });
});

describe("detectSolThresholdCrossings: stale/wrong-run telemetry", () => {
  it("fires sol-stale-wrong-run-telemetry on high epoch overhead (≥3)", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        duration: { dimension: "duration", score: 0.25, confidence: "high", detail: "dispatch_epoch=5, continue_epoch=1" },
        dispatch: { dimension: "dispatch", score: 0.25, confidence: "high", detail: "redispatched=3/4" },
      }),
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ stale_wrong_run_telemetry: true }), []);
    expect(crossings.some((c) => c.code === "sol-stale-wrong-run-telemetry")).toBe(true);
  });

  it("does NOT fire when stale_wrong_run_telemetry is false", () => {
    const report = makeScoreReport({
      foreman: makeForeman({
        duration: { dimension: "duration", score: 0.0, confidence: "high", detail: "dispatch_epoch=10, continue_epoch=1" },
      }),
    });
    const crossings = detectSolThresholdCrossings(report, enabledThresholds({ stale_wrong_run_telemetry: false }), []);
    expect(crossings.some((c) => c.code === "sol-stale-wrong-run-telemetry")).toBe(false);
  });
});

describe("detectSolThresholdCrossings: evidence refs propagated", () => {
  it("includes evidence paths in each crossing", () => {
    const report = makeScoreReport({ run_composite_score: 0.2 });
    const evidencePaths = [".polaris/runs/test-run-001/sol-score.json"];
    const crossings = detectSolThresholdCrossings(report, enabledThresholds(), evidencePaths);
    expect(crossings.length).toBeGreaterThan(0);
    for (const c of crossings) {
      expect(c.evidenceRefs).toEqual(evidencePaths);
    }
  });
});

// ── evaluateSolThresholds: advisory default ───────────────────────────────────

describe("evaluateSolThresholds: advisory default (disabled)", () => {
  it("does NOT create a run-health report when enabled is false (default)", () => {
    const report = makeScoreReport({ run_composite_score: 0.1 });
    const result = evaluateSolThresholds({
      runId: "run-advisory-001",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: { enabled: false, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });
    expect(result.symptomsAppended).toBe(0);
    expect(readRunHealthReport("run-advisory-001", tmpRoot)).toBeNull();
    cleanup();
  });

  it("does NOT create a run-health report when policy.createRunHealthReport is absent", () => {
    const report = makeScoreReport({ run_composite_score: 0.1 });
    const result = evaluateSolThresholds({
      runId: "run-advisory-002",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: { enabled: true }, // policy missing → advisory
      repoRoot: tmpRoot,
    });
    expect(result.symptomsAppended).toBe(0);
    expect(readRunHealthReport("run-advisory-002", tmpRoot)).toBeNull();
    cleanup();
  });

  it("still detects crossings even when advisory (no-op write)", () => {
    const report = makeScoreReport({ run_composite_score: 0.1 });
    const result = evaluateSolThresholds({
      runId: "run-advisory-003",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: { enabled: true }, // advisory
      repoRoot: tmpRoot,
    });
    expect(result.crossings.some((c) => c.code === "sol-low-composite-score")).toBe(true);
    cleanup();
  });
});

// ── evaluateSolThresholds: policy.createRunHealthReport ───────────────────────

describe("evaluateSolThresholds: policy.createRunHealthReport=true", () => {
  it("creates a run-health report when a threshold is crossed and policy is enabled", () => {
    const report = makeScoreReport({ run_composite_score: 0.2 });
    const result = evaluateSolThresholds({
      runId: "run-create-001",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: enabledThresholds(),
      repoRoot: tmpRoot,
    });
    expect(result.symptomsAppended).toBeGreaterThan(0);
    const healthReport = readRunHealthReport("run-create-001", tmpRoot);
    expect(healthReport).not.toBeNull();
    expect(healthReport!.symptoms.some((s) => s.code === "sol-low-composite-score")).toBe(true);
    cleanup();
  });

  it("SOL-created symptoms reference source evidence and do not mutate metric artifacts", () => {
    const evidencePath = ".polaris/runs/run-create-002/sol-score.json";
    const report = makeScoreReport({ run_composite_score: 0.2 });
    evaluateSolThresholds({
      runId: "run-create-002",
      clusterId: "POL-TEST",
      scoreReport: report,
      evidencePaths: [evidencePath],
      thresholdsConfig: enabledThresholds(),
      repoRoot: tmpRoot,
    });
    const healthReport = readRunHealthReport("run-create-002", tmpRoot);
    expect(healthReport!.symptoms[0].evidence_refs).toContain(evidencePath);
    // source_actor.role must be "sol" — not "foreman", "worker", etc.
    expect(healthReport!.symptoms[0].source_actor.role).toBe("sol");
    cleanup();
  });

  it("does not create a report when no thresholds are crossed", () => {
    const report = makeScoreReport({ run_composite_score: 0.9 }); // healthy
    const result = evaluateSolThresholds({
      runId: "run-clean-001",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: enabledThresholds(),
      repoRoot: tmpRoot,
    });
    expect(result.symptomsAppended).toBe(0);
    expect(readRunHealthReport("run-clean-001", tmpRoot)).toBeNull();
    cleanup();
  });
});

// ── evaluateSolThresholds: policy.requireMedic ───────────────────────────────

describe("evaluateSolThresholds: policy.requireMedic=true", () => {
  it("sets medic_consult to pending when requireMedic is true and a crossing fires", () => {
    const report = makeScoreReport({ run_composite_score: 0.1 });
    const result = evaluateSolThresholds({
      runId: "run-medic-001",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: {
        enabled: true,
        policy: { createRunHealthReport: true, requireMedic: true },
      },
      repoRoot: tmpRoot,
    });
    expect(result.medicRequired).toBe(true);
    const healthReport = readRunHealthReport("run-medic-001", tmpRoot);
    expect(healthReport!.medic_consult?.status).toBe("pending");
    cleanup();
  });

  it("does NOT set medic pending when no thresholds fire", () => {
    const report = makeScoreReport({ run_composite_score: 0.9 });
    const result = evaluateSolThresholds({
      runId: "run-medic-002",
      clusterId: "POL-TEST",
      scoreReport: report,
      thresholdsConfig: {
        enabled: true,
        policy: { createRunHealthReport: true, requireMedic: true },
      },
      repoRoot: tmpRoot,
    });
    expect(result.medicRequired).toBe(false);
    expect(readRunHealthReport("run-medic-002", tmpRoot)).toBeNull();
    cleanup();
  });
});

// ── evaluateSolThresholds: never throws ──────────────────────────────────────

describe("evaluateSolThresholds: never throws", () => {
  it("does not throw when repoRoot is invalid/unwritable", () => {
    const report = makeScoreReport({ run_composite_score: 0.1 });
    expect(() =>
      evaluateSolThresholds({
        runId: "run-nothrow-001",
        clusterId: "POL-TEST",
        scoreReport: report,
        thresholdsConfig: enabledThresholds(),
        repoRoot: "/dev/null/nonexistent",
      }),
    ).not.toThrow();
  });

  it("does not throw when score report has null scores", () => {
    const report = makeScoreReport({
      run_composite_score: null,
      foreman: makeForeman({ composite_score: null }),
    });
    expect(() =>
      evaluateSolThresholds({
        runId: "run-nothrow-002",
        clusterId: "POL-TEST",
        scoreReport: report,
        thresholdsConfig: enabledThresholds(),
        repoRoot: tmpRoot,
      }),
    ).not.toThrow();
    cleanup();
  });
});
