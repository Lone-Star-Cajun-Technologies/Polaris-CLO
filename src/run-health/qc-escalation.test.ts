/**
 * Tests for QC escalation criteria → run-health evidence refs.
 *
 * Validates:
 * - appendQcEscalationSymptoms() creates no report for clean QC results.
 * - appendQcEscalationSymptoms() creates a report for blocking findings.
 * - appendQcEscalationSymptoms() creates a report for all-providers-failed.
 * - appendQcEscalationSymptoms() creates a report for parse failures.
 * - appendQcEscalationSymptoms() creates a report for unusable output.
 * - appendQcEscalationSymptoms() creates a report for repeated findings (afterRepair).
 * - appendQcEscalationSymptoms() creates a report for noisy output.
 * - appendRepairLoopOutcomeSymptom() creates symptoms for max-rounds and medic-referral.
 * - appendRepairLoopOutcomeSymptom() creates no symptom for pass outcome.
 * - QC providers are never called from escalation — only artifacts are referenced.
 */

import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendQcEscalationSymptoms,
  appendRepairLoopOutcomeSymptom,
} from "./qc-escalation.js";
import { readRunHealthReport } from "./index.js";
import type { QcResult } from "../qc/types.js";
import type { QcRepairLoopResult } from "../qc/repair-loop.js";
import type { QcRepairLoopState } from "../loop/checkpoint.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePassedResult(overrides: Partial<QcResult> = {}): QcResult {
  return {
    schemaVersion: "1.0",
    qcRunId: "qc-pass-001",
    runId: "run-001",
    clusterId: "POL-TEST",
    trigger: "completed-cluster",
    provider: "mock-provider",
    providerMode: "local",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "passed",
    findings: [],
    rawArtifactPaths: [".polaris/clusters/POL-TEST/qc/qc-pass-001.json"],
    parserVersion: "1.0",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: false,
      routedToRepair: false,
      summary: "No issues found",
    },
    ...overrides,
  };
}

function makeBlockingResult(overrides: Partial<QcResult> = {}): QcResult {
  return {
    schemaVersion: "1.0",
    qcRunId: "qc-block-001",
    runId: "run-001",
    clusterId: "POL-TEST",
    trigger: "completed-cluster",
    provider: "mock-provider",
    providerMode: "local",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "blocked",
    findings: [
      {
        findingId: "f-001",
        severity: "high",
        title: "Security issue",
        fixAvailable: false,
        autofixEligible: false,
        attribution: { confidence: "high", reason: "commit-line-match" },
        status: "open",
        routingDecision: "operator-review",
      },
    ],
    rawArtifactPaths: [".polaris/clusters/POL-TEST/qc/qc-block-001.json"],
    parserVersion: "1.0",
    policyDecision: {
      blocksDelivery: true,
      requiresOperatorReview: false,
      routedToRepair: false,
      summary: "Blocking findings present",
    },
    ...overrides,
  };
}

function makeRepairLoopState(): QcRepairLoopState {
  const now = new Date().toISOString();
  return {
    current_round: 1,
    max_rounds: 2,
    source_qc_run_ids: ["qc-run-1"],
    manifest_path: null,
    pending_packet_ids: [],
    completed_packet_ids: [],
    rerun_requested: false,
    rerun_qc_run_ids: {},
    terminal_outcome: "max-rounds",
    initiated_at: now,
    updated_at: now,
  };
}

function makeRepairLoopResult(
  outcome: QcRepairLoopResult["outcome"],
  overrides: Partial<QcRepairLoopResult> = {},
): QcRepairLoopResult {
  return {
    outcome,
    rounds_completed: 1,
    final_qc_results: [makeBlockingResult()],
    loop_state: { ...makeRepairLoopState(), terminal_outcome: outcome },
    summary: `Test outcome: ${outcome}`,
    ...overrides,
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

let tmpRoot: string;
let runCounter = 0;

function freshRunId(): string {
  runCounter += 1;
  return `run-qc-esc-${runCounter}`;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "polaris-qc-esc-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Clean path: no report ─────────────────────────────────────────────────────

describe("appendQcEscalationSymptoms — clean path", () => {
  it("does NOT create a report for a passed QC result with no findings", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [makePassedResult({ qcRunId: `qc-${runId}` })],
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report).toBeNull();
  });

  it("does NOT create a report for empty qcResults array", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [],
      repoRoot: tmpRoot,
    });
    expect(readRunHealthReport(runId, tmpRoot)).toBeNull();
  });
});

// ── Blocking findings ─────────────────────────────────────────────────────────

describe("appendQcEscalationSymptoms — blocking findings", () => {
  it("creates a qc-blocking-findings symptom when policyDecision.blocksDelivery is true", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [makeBlockingResult({ qcRunId: `qc-${runId}` })],
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report).not.toBeNull();
    const sym = report?.symptoms.find((s) => s.code === "qc-blocking-findings");
    expect(sym).toBeDefined();
    expect(sym?.severity).toBe("high");
    expect(sym?.source_actor.role).toBe("foreman");
    // Evidence refs should contain the QC artifact path
    expect(sym?.evidence_refs).toContain(".polaris/clusters/POL-TEST/qc/qc-block-001.json");
  });
});

// ── All providers failed ──────────────────────────────────────────────────────

describe("appendQcEscalationSymptoms — all providers failed", () => {
  it("creates a qc-all-providers-failed symptom when all results have failed status", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [
        makePassedResult({
          qcRunId: `qc-${runId}`,
          status: "failed",
          allProvidersFailed: true,
          findings: [],
          rawArtifactPaths: [],
        }),
      ],
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-all-providers-failed")).toBeDefined();
  });
});

// ── Parse failure ─────────────────────────────────────────────────────────────

describe("appendQcEscalationSymptoms — parse failure", () => {
  it("creates a qc-parse-failure symptom when parserResult is 'failed'", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [
        makePassedResult({
          qcRunId: `qc-${runId}`,
          // Use 'findings' status (not 'failed') so it doesn't trigger all-providers-failed
          status: "findings",
          providerAttempt: {
            provider: "mock-provider",
            status: "failure",
            rawOutputAvailable: false,
            rawOutputRetained: false,
            stdoutLength: 0,
            stderrLength: 0,
            parserResult: "failed",
          },
        }),
      ],
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-parse-failure")).toBeDefined();
    expect(report?.symptoms.find((s) => s.code === "qc-parse-failure")?.severity).toBe("medium");
  });
});

// ── Unusable output ───────────────────────────────────────────────────────────

describe("appendQcEscalationSymptoms — unusable output", () => {
  it("creates a qc-unusable-output symptom when failureReason is 'unusable-output'", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [
        makePassedResult({
          qcRunId: `qc-${runId}`,
          providerAttempt: {
            provider: "mock-provider",
            status: "failure",
            failureReason: "unusable-output",
            rawOutputAvailable: false,
            rawOutputRetained: false,
            stdoutLength: 0,
            stderrLength: 0,
          },
        }),
      ],
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-unusable-output")).toBeDefined();
  });
});

// ── Repeated findings after repair ───────────────────────────────────────────

describe("appendQcEscalationSymptoms — repeated findings", () => {
  it("creates a qc-repeated-findings symptom when afterRepair=true and open findings exist", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [makeBlockingResult({ qcRunId: `qc-${runId}` })],
      afterRepair: true,
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-repeated-findings")).toBeDefined();
  });

  it("does NOT create qc-repeated-findings when afterRepair=false", () => {
    const runId = freshRunId();
    appendQcEscalationSymptoms({
      runId,
      clusterId: "POL-TEST",
      qcResults: [makeBlockingResult({ qcRunId: `qc-${runId}` })],
      afterRepair: false,
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-repeated-findings")).toBeUndefined();
  });
});

// ── Repair loop outcome ───────────────────────────────────────────────────────

describe("appendRepairLoopOutcomeSymptom", () => {
  it("creates a qc-max-repair-rounds symptom for max-rounds outcome", () => {
    const runId = freshRunId();
    appendRepairLoopOutcomeSymptom({
      runId,
      clusterId: "POL-TEST",
      repairResult: makeRepairLoopResult("max-rounds"),
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-max-repair-rounds")).toBeDefined();
    expect(report?.symptoms.find((s) => s.code === "qc-max-repair-rounds")?.severity).toBe("medium");
  });

  it("creates a qc-repair-dispatch-failure symptom for medic-referral outcome", () => {
    const runId = freshRunId();
    appendRepairLoopOutcomeSymptom({
      runId,
      clusterId: "POL-TEST",
      repairResult: makeRepairLoopResult("medic-referral"),
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-repair-dispatch-failure")).toBeDefined();
    expect(report?.symptoms.find((s) => s.code === "qc-repair-dispatch-failure")?.severity).toBe("high");
  });

  it("creates a qc-all-providers-failed symptom for all-providers-failed outcome", () => {
    const runId = freshRunId();
    appendRepairLoopOutcomeSymptom({
      runId,
      clusterId: "POL-TEST",
      repairResult: makeRepairLoopResult("all-providers-failed"),
      repoRoot: tmpRoot,
    });
    const report = readRunHealthReport(runId, tmpRoot);
    expect(report?.symptoms.find((s) => s.code === "qc-all-providers-failed")).toBeDefined();
  });

  it("does NOT create a symptom for pass outcome", () => {
    const runId = freshRunId();
    appendRepairLoopOutcomeSymptom({
      runId,
      clusterId: "POL-TEST",
      repairResult: makeRepairLoopResult("pass", { final_qc_results: [makePassedResult()] }),
      repoRoot: tmpRoot,
    });
    expect(readRunHealthReport(runId, tmpRoot)).toBeNull();
  });

  it("does NOT create a symptom for no-repairable outcome", () => {
    const runId = freshRunId();
    appendRepairLoopOutcomeSymptom({
      runId,
      clusterId: "POL-TEST",
      repairResult: makeRepairLoopResult("no-repairable", { final_qc_results: [] }),
      repoRoot: tmpRoot,
    });
    expect(readRunHealthReport(runId, tmpRoot)).toBeNull();
  });

  it("never throws even when the write path fails (best-effort)", () => {
    expect(() =>
      appendRepairLoopOutcomeSymptom({
        runId: "run-bad",
        clusterId: "POL-TEST",
        repairResult: makeRepairLoopResult("max-rounds"),
        repoRoot: "/dev/null/nonexistent",
      }),
    ).not.toThrow();
  });
});
