/**
 * POL-509 regression fixture.
 *
 * Proves end-to-end behavior for the run-health Medic gate under failure
 * conditions representative of the POL-509 incident:
 *   - Repeated CodeRabbit (QC provider) failures with wrong-run telemetry
 *   - Budget-exhausted telemetry signals
 *   - Finalize retries blocked by run-health report
 *   - Eventual QC pass after repair loop
 *
 * Acceptance criteria verified:
 *   [AC-1] SOL threshold bridge appends run-health symptoms from score evidence.
 *   [AC-2] A run-health report exists after symptoms are recorded.
 *   [AC-3] validateMedicGate blocks finalize (returns blocker string) when
 *          the report exists but no Medic decision has been recorded.
 *   [AC-4] validateMedicGate allows finalize after Medic records "resolved".
 *   [AC-5] validateMedicGate allows finalize after Medic records "bypassed".
 *   [AC-6] SOL-created symptoms reference source evidence and use role="sol".
 *   [AC-7] Symptoms do NOT mutate raw metric artifacts (verified via readback).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectSolThresholdCrossings,
  evaluateSolThresholds,
} from "../autoresearch/sol-run-health-bridge.js";
import {
  readRunHealthReport,
  markMedicDecision,
} from "../run-health/index.js";
import { validateMedicGate } from "./medic-gate.js";
import { appendQcEscalationSymptoms } from "../run-health/qc-escalation.js";
import { appendForemanSymptom } from "../run-health/foreman-symptoms.js";
import type { SolScoreReport, SolForemanScoreReport, SolWorkerScoreReport } from "../types/sol-score.js";
import type { QcResult } from "../qc/types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers / fixtures
// ──────────────────────────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-pol509-regression-"));
});

afterEach(() => {
  cleanup();
});

function cleanup() {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* no-op */ }
}

/**
 * Simulates the SOL score report produced after a POL-509-style run:
 *   - Multiple CodeRabbit failures (QC repair loop → medic-referral terminal)
 *   - Foreman re-dispatched children multiple times (wrong-run telemetry)
 *   - Budget exhausted (dispatch_epoch >> continue_epoch)
 *   - Workers produced 0-score composites (failed validation)
 */
function makePol509ScoreReport(): SolScoreReport {
  const foreman: SolForemanScoreReport = {
    composite_score: 0.15,
    composite_confidence: "high",
    token: { dimension: "token", score: 1.0, confidence: "high", detail: "max_bootstrap_tokens=120000" },
    // dispatch_epoch far exceeds continue_epoch → wrong-run telemetry signal
    duration: { dimension: "duration", score: 0.0, confidence: "high", detail: "dispatch_epoch=6, continue_epoch=1" },
    intervention: { dimension: "intervention", score: 0.0, confidence: "high", detail: "user_intervened=true" },
    pre_analysis: { dimension: "pre_analysis", score: 0.0, confidence: "high", detail: "escalation_events=5" },
    dependency: { dimension: "dependency", score: 0.34, confidence: "medium", detail: "redispatch_count=2" },
    // High redispatch count matches wrong-run pattern
    dispatch: { dimension: "dispatch", score: 0.25, confidence: "high", detail: "redispatched=3/4" },
    evidence_validation: { dimension: "evidence_validation", score: 0.5, confidence: "medium", detail: "mean_heartbeats_per_child=2.5" },
    scope: { dimension: "scope", score: 0.5, confidence: "medium", detail: "out_of_scope_events=1" },
    completion: { dimension: "completion", score: 0.5, confidence: "high", detail: "succeeded=2/4" },
    recovery: { dimension: "recovery", score: 0.0, confidence: "high", detail: "state_repair_required=true" },
    // QC repair loop terminated with Medic referral — CodeRabbit repeated failures
    qc_repair_loop: {
      dimension: "qc_repair_loop",
      score: 0.0,
      confidence: "high",
      detail: "status=medic-referral, failed_packets=2, rerun=failed",
    },
  };

  const workers: Record<string, SolWorkerScoreReport> = {
    "POL-518": {
      child_id: "POL-518",
      composite_score: 0.0,
      composite_confidence: "high",
      token: { dimension: "token", score: null, confidence: "none", skipped_reason: "no token data" },
      duration: { dimension: "duration", score: 0.5, confidence: "medium", detail: "heartbeat_count=8" },
      validation: { dimension: "validation", score: 0.0, confidence: "high", detail: "validation=failed" },
      qc: { dimension: "qc", score: null, confidence: "none", skipped_reason: "per-child QC unavailable" },
      repair_iterations: { dimension: "repair_iterations", score: 0.0, confidence: "high", detail: "escalation_count=4" },
      scope_adherence: { dimension: "scope_adherence", score: 1.0, confidence: "medium", detail: "no out-of-scope events observed" },
      acceptance_criteria: { dimension: "acceptance_criteria", score: 0.0, confidence: "high", detail: "status=failed, validation=failed" },
      first_pass: { dimension: "first_pass", score: 0.0, confidence: "high", detail: "user_intervened=true" },
    },
    "POL-519": {
      child_id: "POL-519",
      composite_score: 0.0,
      composite_confidence: "high",
      token: { dimension: "token", score: null, confidence: "none", skipped_reason: "no token data" },
      duration: { dimension: "duration", score: 0.5, confidence: "medium", detail: "heartbeat_count=12" },
      validation: { dimension: "validation", score: 0.0, confidence: "high", detail: "validation=failed" },
      qc: { dimension: "qc", score: null, confidence: "none", skipped_reason: "per-child QC unavailable" },
      repair_iterations: { dimension: "repair_iterations", score: 0.0, confidence: "high", detail: "escalation_count=3" },
      scope_adherence: { dimension: "scope_adherence", score: 1.0, confidence: "medium", detail: "no out-of-scope events observed" },
      acceptance_criteria: { dimension: "acceptance_criteria", score: 0.0, confidence: "high", detail: "status=failed, validation=failed" },
      first_pass: { dimension: "first_pass", score: 0.0, confidence: "high", detail: "user_intervened=true" },
    },
    // One worker eventually passed after repair
    "POL-520": {
      child_id: "POL-520",
      composite_score: 0.75,
      composite_confidence: "medium",
      token: { dimension: "token", score: null, confidence: "none", skipped_reason: "no token data" },
      duration: { dimension: "duration", score: 0.5, confidence: "medium", detail: "heartbeat_count=6" },
      validation: { dimension: "validation", score: 1.0, confidence: "high", detail: "validation=passed" },
      qc: { dimension: "qc", score: null, confidence: "none", skipped_reason: "per-child QC unavailable" },
      repair_iterations: { dimension: "repair_iterations", score: 0.5, confidence: "high", detail: "escalation_count=2" },
      scope_adherence: { dimension: "scope_adherence", score: 1.0, confidence: "medium", detail: "no out-of-scope events observed" },
      acceptance_criteria: { dimension: "acceptance_criteria", score: 1.0, confidence: "high", detail: "status=done, validation=passed" },
      first_pass: { dimension: "first_pass", score: 0.5, confidence: "high", detail: "foreman_intervened=true" },
    },
    "POL-521": {
      child_id: "POL-521",
      composite_score: 0.0,
      composite_confidence: "high",
      token: { dimension: "token", score: null, confidence: "none", skipped_reason: "no token data" },
      duration: { dimension: "duration", score: 0.5, confidence: "medium", detail: "heartbeat_count=9" },
      validation: { dimension: "validation", score: 0.0, confidence: "high", detail: "validation=failed" },
      qc: { dimension: "qc", score: null, confidence: "none", skipped_reason: "per-child QC unavailable" },
      repair_iterations: { dimension: "repair_iterations", score: 0.0, confidence: "high", detail: "escalation_count=5" },
      scope_adherence: { dimension: "scope_adherence", score: 1.0, confidence: "medium", detail: "no out-of-scope events observed" },
      acceptance_criteria: { dimension: "acceptance_criteria", score: 0.0, confidence: "high", detail: "status=failed, validation=failed" },
      first_pass: { dimension: "first_pass", score: 0.0, confidence: "high", detail: "user_intervened=true" },
    },
  };

  return {
    run_id: "polaris-run-pol-509-regression",
    cluster_id: "POL-509",
    scored_at: new Date().toISOString(),
    foreman,
    workers,
    run_composite_score: 0.15,
  };
}

const ISO_NOW = new Date().toISOString();

const baseAttribution = {
  confidence: "unattributed" as const,
  reason: "unattributed" as const,
};

const basePolicyDecision = {
  blocksDelivery: false,
  requiresOperatorReview: false,
  routedToRepair: false,
  summary: "",
};

/**
 * Simulates the CodeRabbit QC results for repeated failures in the repair loop.
 * Matches the pattern observed in POL-509: parse failures + blocking findings surviving repair.
 */
function makeCodeRabbitQcFailures(runId: string): QcResult[] {
  const qcDir = `.polaris/clusters/POL-509/qc`;
  return [
    {
      schemaVersion: "1.0",
      qcRunId: `${runId}-cr-001`,
      runId,
      clusterId: "POL-509",
      trigger: "completed-cluster" as const,
      provider: "coderabbit",
      providerMode: "local" as const,
      startedAt: ISO_NOW,
      completedAt: ISO_NOW,
      status: "failed" as const,
      findings: [],
      allProvidersFailed: false,
      rawArtifactPaths: [`${qcDir}/${runId}-cr-001.json`],
      parserVersion: "1.0",
      providerAttempt: {
        provider: "coderabbit",
        status: "failure" as const,
        parserResult: "failed" as const,
        failureReason: "unusable-output" as const,
        rawOutputAvailable: false,
        rawOutputRetained: false,
        stdoutLength: 0,
        stderrLength: 0,
      },
      policyDecision: { ...basePolicyDecision },
    },
    {
      schemaVersion: "1.0",
      qcRunId: `${runId}-cr-002`,
      runId,
      clusterId: "POL-509",
      trigger: "completed-cluster" as const,
      provider: "coderabbit",
      providerMode: "local" as const,
      startedAt: ISO_NOW,
      completedAt: ISO_NOW,
      status: "blocked" as const,
      findings: [
        {
          findingId: "f-001",
          severity: "high" as const,
          title: "Missing null check",
          status: "open" as const,
          fixAvailable: true,
          autofixEligible: false,
          attribution: { ...baseAttribution },
        },
        {
          findingId: "f-002",
          severity: "high" as const,
          title: "Type assertion unsafe",
          status: "open" as const,
          fixAvailable: false,
          autofixEligible: false,
          attribution: { ...baseAttribution },
        },
      ],
      allProvidersFailed: false,
      rawArtifactPaths: [`${qcDir}/${runId}-cr-002.json`],
      parserVersion: "1.0",
      providerAttempt: {
        provider: "coderabbit",
        status: "success" as const,
        parserResult: "success" as const,
        rawOutputAvailable: true,
        rawOutputRetained: true,
        stdoutLength: 256,
        stderrLength: 0,
      },
      policyDecision: { ...basePolicyDecision, blocksDelivery: true, summary: "blocking open findings" },
    },
  ];
}

// ──────────────────────────────────────────────────────────────────────────────
// [AC-1] + [AC-2]: SOL threshold bridge creates run-health symptoms
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression: SOL thresholds produce run-health symptoms", () => {
  it("[AC-1] detects multiple threshold crossings in a POL-509-like score report", () => {
    const scoreReport = makePol509ScoreReport();
    const crossings = detectSolThresholdCrossings(
      scoreReport,
      {
        enabled: true,
        low_composite_score: 0.4,
        qc_repair_loop_failure_statuses: ["medic-referral", "max-rounds", "all-providers-failed"],
        repeated_provider_failures: 3,
        foreman_intervention_count: 2,
        stale_wrong_run_telemetry: true,
        validation_failures: 2,
      },
      [],
    );

    expect(crossings.some((c) => c.code === "sol-low-composite-score")).toBe(true);
    expect(crossings.some((c) => c.code === "sol-qc-repair-loop-failure")).toBe(true);
    expect(crossings.some((c) => c.code === "sol-repeated-provider-failures")).toBe(true);
    expect(crossings.some((c) => c.code === "sol-high-foreman-intervention")).toBe(true);
    expect(crossings.some((c) => c.code === "sol-stale-wrong-run-telemetry")).toBe(true);
    expect(crossings.some((c) => c.code === "sol-validation-failures")).toBe(true);
  });

  it("[AC-2] creates a run-health report with SOL symptoms when policy is enabled", () => {
    const scoreReport = makePol509ScoreReport();
    const solEvidencePath = ".polaris/runs/polaris-run-pol-509-regression/sol-score.json";

    evaluateSolThresholds({
      runId: "polaris-run-pol-509-regression",
      clusterId: "POL-509",
      scoreReport,
      evidencePaths: [solEvidencePath],
      thresholdsConfig: {
        enabled: true,
        policy: { createRunHealthReport: true },
        low_composite_score: 0.4,
        qc_repair_loop_failure_statuses: ["medic-referral", "max-rounds", "all-providers-failed"],
        repeated_provider_failures: 3,
        foreman_intervention_count: 2,
        stale_wrong_run_telemetry: true,
        validation_failures: 2,
      },
      repoRoot: tmpRoot,
    });

    const report = readRunHealthReport("polaris-run-pol-509-regression", tmpRoot);
    expect(report).not.toBeNull();
    expect(report!.symptoms.length).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// [AC-6] + [AC-7]: Symptom evidence refs and no metric mutation
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression: symptom evidence integrity", () => {
  it("[AC-6] SOL-created symptoms reference source evidence and have role=sol", () => {
    const solEvidencePath = ".polaris/runs/polaris-run-pol-509-regression/sol-score.json";
    evaluateSolThresholds({
      runId: "polaris-run-pol-509-evidence",
      clusterId: "POL-509",
      scoreReport: makePol509ScoreReport(),
      evidencePaths: [solEvidencePath],
      thresholdsConfig: { enabled: true, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport("polaris-run-pol-509-evidence", tmpRoot);
    expect(report).not.toBeNull();
    for (const symptom of report!.symptoms) {
      expect(symptom.source_actor.role).toBe("sol");
      expect(symptom.evidence_refs).toContain(solEvidencePath);
    }
  });

  it("[AC-7] SOL symptoms do not mutate raw metric artifacts (evidence file unchanged)", async () => {
    // Write a fake raw SOL evidence artifact
    const evDir = join(tmpRoot, ".polaris", "runs", "polaris-run-pol-509-mutation");
    mkdirSync(evDir, { recursive: true });
    const rawArtifactPath = join(evDir, "sol-score.json");
    const originalContent = JSON.stringify({ original: true, score: 0.15 });
    writeFileSync(rawArtifactPath, originalContent);

    evaluateSolThresholds({
      runId: "polaris-run-pol-509-mutation",
      clusterId: "POL-509",
      scoreReport: makePol509ScoreReport(),
      evidencePaths: [rawArtifactPath],
      thresholdsConfig: { enabled: true, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });

    // Verify raw artifact is untouched
    const afterContent = readFileSync(rawArtifactPath, "utf-8");
    expect(afterContent).toBe(originalContent);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// QC escalation: repeated CodeRabbit failures produce symptoms
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression: QC escalation from CodeRabbit failures", () => {
  it("appends QC escalation symptoms for parse failures + blocking findings", () => {
    const runId = "polaris-run-pol-509-qc";
    const qcResults = makeCodeRabbitQcFailures(runId);

    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-509",
      qcResults,
      afterRepair: false,
      repoRoot: tmpRoot,
    });

    const report = readRunHealthReport(runId, tmpRoot);
    expect(report).not.toBeNull();
    const codes = report!.symptoms.map((s) => s.code);
    expect(codes).toContain("qc-parse-failure");
    expect(codes).toContain("qc-blocking-findings");
  });

  it("adds repeated-findings symptom when blocking findings survive repair loop", () => {
    const runId = "polaris-run-pol-509-repair";
    const qcResults = makeCodeRabbitQcFailures(runId);
    // Initial run — create report first
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-509",
      qcResults: [qcResults[0]!],
      afterRepair: false,
      repoRoot: tmpRoot,
    });
    // Post-repair: findings still present → repeated-findings symptom
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-509",
      qcResults: [qcResults[1]!],
      afterRepair: true,
      repoRoot: tmpRoot,
    });

    const report = readRunHealthReport(runId, tmpRoot);
    const codes = report!.symptoms.map((s) => s.code);
    expect(codes).toContain("qc-repeated-findings");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Wrong-run / budget-exhausted symptoms from Foreman
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression: wrong-run and finalize-recovery symptoms", () => {
  it("records wrong-run-telemetry Foreman symptom when enabled", () => {
    appendForemanSymptom({
      runId: "polaris-run-pol-509-wrr",
      clusterId: "POL-509",
      code: "foreman-wrong-run-telemetry",
      message: "Worker returned result for a different run ID — budget may have been exhausted during prior attempt.",
      evidenceRefs: [".taskchain_artifacts/polaris-run/runs/polaris-run-pol-509-wrr/telemetry.jsonl"],
      repoRoot: tmpRoot,
      config: { run_health: { foreman_symptoms: { enabled: true } } },
    });

    const report = readRunHealthReport("polaris-run-pol-509-wrr", tmpRoot);
    expect(report).not.toBeNull();
    expect(report!.symptoms[0].code).toBe("foreman-wrong-run-telemetry");
    expect(report!.symptoms[0].severity).toBe("high");
  });

  it("records finalize-recovery symptom (simulates finalize retry after failure)", () => {
    appendForemanSymptom({
      runId: "polaris-run-pol-509-finalize",
      clusterId: "POL-509",
      code: "foreman-finalize-recovery",
      message: "Finalize step failed and was retried — state may be partially committed.",
      repoRoot: tmpRoot,
      config: { run_health: { foreman_symptoms: { enabled: true } } },
    });

    const report = readRunHealthReport("polaris-run-pol-509-finalize", tmpRoot);
    expect(report!.symptoms[0].code).toBe("foreman-finalize-recovery");
    expect(report!.symptoms[0].severity).toBe("medium");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// [AC-3]: Finalize blocks when run-health report exists without Medic decision
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression [AC-3]: finalize blocked by run-health Medic gate", () => {
  it("validateMedicGate returns a blocker string when report exists and no Medic decision", () => {
    const runId = "polaris-run-pol-509-gate-block";
    // Build up a run-health report via SOL thresholds (POL-509 scenario)
    evaluateSolThresholds({
      runId,
      clusterId: "POL-509",
      scoreReport: makePol509ScoreReport(),
      thresholdsConfig: { enabled: true, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });

    // Verify report exists
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report).not.toBeNull();
    expect(report!.medic_consult).toBeUndefined();

    // Gate must block
    const blocker = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blocker).not.toBeNull();
    expect(blocker).toContain("Medic consultation decision");
  });

  it("validateMedicGate blocks even when report was created by QC escalation", () => {
    const runId = "polaris-run-pol-509-gate-qc";
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-509",
      qcResults: makeCodeRabbitQcFailures(runId),
      repoRoot: tmpRoot,
    });

    const blocker = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blocker).not.toBeNull();
  });

  it("validateMedicGate passes when no run-health report exists (no symptoms)", () => {
    const runId = "polaris-run-pol-509-gate-clean";
    // No symptoms → no report → gate passes
    const blocker = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blocker).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// [AC-4] + [AC-5]: Finalize proceeds after Medic decision
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression [AC-4]: finalize proceeds after Medic resolved", () => {
  it("validateMedicGate returns null after Medic records 'resolved' (no-treatment-needed)", () => {
    const runId = "polaris-run-pol-509-resolved";
    evaluateSolThresholds({
      runId,
      clusterId: "POL-509",
      scoreReport: makePol509ScoreReport(),
      thresholdsConfig: { enabled: true, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });

    // Medic reviews and decides no treatment needed
    markMedicDecision(
      runId,
      {
        status: "resolved",
        resolvedAt: new Date().toISOString(),
        resolutionNotes: "No treatment needed — symptoms are informational; QC repair succeeded on retry.",
      },
      tmpRoot,
    );

    const blocker = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blocker).toBeNull();
  });

  it("validateMedicGate returns null after Medic records 'resolved' (treatment-complete)", () => {
    const runId = "polaris-run-pol-509-treatment";
    evaluateSolThresholds({
      runId,
      clusterId: "POL-509",
      scoreReport: makePol509ScoreReport(),
      thresholdsConfig: { enabled: true, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });

    // Medic applies treatment and records completion
    markMedicDecision(
      runId,
      {
        status: "resolved",
        chartRefs: [".polaris/charts/CHART-2026-07-09-001.md"],
        treatmentPacketRefs: [".polaris/clusters/POL-509/medic/treatment-001.json"],
        resolvedAt: new Date().toISOString(),
        resolutionNotes: "Treatment applied: provider routing updated, stale state cleared.",
      },
      tmpRoot,
    );

    const blocker = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blocker).toBeNull();
  });
});

describe("POL-509 regression [AC-5]: finalize proceeds after Medic bypassed", () => {
  it("validateMedicGate returns null after Medic records 'bypassed' status", () => {
    const runId = "polaris-run-pol-509-bypassed";
    evaluateSolThresholds({
      runId,
      clusterId: "POL-509",
      scoreReport: makePol509ScoreReport(),
      thresholdsConfig: { enabled: true, policy: { createRunHealthReport: true } },
      repoRoot: tmpRoot,
    });

    markMedicDecision(
      runId,
      {
        status: "bypassed",
        resolutionNotes: "Operator bypassed: QC findings were false positives.",
      },
      tmpRoot,
    );

    const blocker = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blocker).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// End-to-end: full POL-509 scenario
// ──────────────────────────────────────────────────────────────────────────────

describe("POL-509 regression: end-to-end scenario", () => {
  it("covers the complete POL-509 failure arc: symptoms → block → medic resolve → pass", () => {
    const runId = "polaris-run-pol-509-e2e";
    const clusterId = "POL-509";

    // === Phase 1: Symptoms accumulate ===

    // 1a. Wrong-run telemetry from Foreman (budget exhausted in prior attempt)
    appendForemanSymptom({
      runId, clusterId,
      code: "foreman-wrong-run-telemetry",
      message: "Worker returned result for a stale run — budget exhausted.",
      repoRoot: tmpRoot,
      config: { run_health: { foreman_symptoms: { enabled: true } } },
    });

    // 1b. Repeated CodeRabbit failures
    appendQcEscalationSymptoms({
      runId, clusterId,
      qcResults: makeCodeRabbitQcFailures(runId),
      afterRepair: false,
      repoRoot: tmpRoot,
    });

    // 1c. Post-repair: findings survived
    appendQcEscalationSymptoms({
      runId, clusterId,
      qcResults: [{
        schemaVersion: "1.0",
        qcRunId: `${runId}-cr-003`,
        runId,
        clusterId,
        trigger: "completed-cluster" as const,
        provider: "coderabbit",
        providerMode: "local" as const,
        startedAt: ISO_NOW,
        completedAt: ISO_NOW,
        status: "blocked" as const,
        findings: [
          {
            findingId: "f-001",
            severity: "high" as const,
            title: "Missing null check",
            status: "open" as const,
            fixAvailable: true,
            autofixEligible: false,
            attribution: { ...baseAttribution },
          },
        ],
        allProvidersFailed: false,
        rawArtifactPaths: [`.polaris/clusters/${clusterId}/qc/${runId}-cr-003.json`],
        parserVersion: "1.0",
        providerAttempt: {
          provider: "coderabbit",
          status: "success" as const,
          parserResult: "success" as const,
          rawOutputAvailable: true,
          rawOutputRetained: true,
          stdoutLength: 200,
          stderrLength: 0,
        },
        policyDecision: { ...basePolicyDecision, blocksDelivery: true, summary: "blocking open findings remain after repair" },
      }],
      afterRepair: true,
      repoRoot: tmpRoot,
    });

    // 1d. SOL scoring reveals degraded composite
    evaluateSolThresholds({
      runId, clusterId,
      scoreReport: makePol509ScoreReport(),
      evidencePaths: [`.polaris/runs/${runId}/sol-score.json`],
      thresholdsConfig: {
        enabled: true,
        policy: { createRunHealthReport: true },
        low_composite_score: 0.4,
        validation_failures: 2,
        stale_wrong_run_telemetry: true,
      },
      repoRoot: tmpRoot,
    });

    // === Phase 2: Verify report exists and finalize is blocked ===

    const report = readRunHealthReport(runId, tmpRoot);
    expect(report).not.toBeNull();
    expect(report!.symptoms.length).toBeGreaterThan(2);
    expect(report!.medic_consult).toBeUndefined();

    const blockerBeforeMediac = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blockerBeforeMediac).not.toBeNull();
    expect(blockerBeforeMediac).toContain("run-health");

    // === Phase 3: Medic reviews and decides — eventually QC passes ===

    markMedicDecision(
      runId,
      {
        status: "resolved",
        chartRefs: [".polaris/charts/CHART-2026-07-09-POL-509.md"],
        treatmentPacketRefs: [".polaris/clusters/POL-509/medic/treatment-POL-509.json"],
        resolvedAt: new Date().toISOString(),
        resolutionNotes:
          "QC review: findings were addressed in final repair pass. " +
          "Wrong-run telemetry explained by interrupted prior run budget exhaustion. " +
          "SOL low-composite is expected given disrupted run arc. " +
          "No further treatment needed.",
      },
      tmpRoot,
    );

    // === Phase 4: Finalize may now proceed ===

    const blockerAfterMedic = validateMedicGate({ runId, repoRoot: tmpRoot });
    expect(blockerAfterMedic).toBeNull();

    // Verify final report shape
    const finalReport = readRunHealthReport(runId, tmpRoot);
    expect(finalReport!.medic_consult!.status).toBe("resolved");
    expect(finalReport!.medic_consult!.chart_refs).toContain(".polaris/charts/CHART-2026-07-09-POL-509.md");
    expect(finalReport!.medic_consult!.treatment_packet_refs).toContain(
      ".polaris/clusters/POL-509/medic/treatment-POL-509.json",
    );

  });
});
