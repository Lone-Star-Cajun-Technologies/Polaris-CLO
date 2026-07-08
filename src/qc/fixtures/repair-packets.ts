import type { QcConfig } from "../../config/schema.js";
import type { QcFinding, QcResult } from "../types.js";

export const DEFAULT_TEST_CONFIG: QcConfig = {
  enabled: true,
  severityThresholds: { block: "high", repair: "medium", followUp: "low" },
};

export function makeFinding(overrides: Partial<QcFinding> = {}): QcFinding {
  return {
    findingId: `f-${Math.random().toString(36).slice(2, 8)}`,
    severity: "medium",
    category: "style",
    title: "Test finding",
    fixAvailable: true,
    autofixEligible: false,
    attribution: { confidence: "high", reason: "changed-file-owner", childId: "POL-472" },
    status: "open",
    ...overrides,
  };
}

export function makeResult(overrides: Partial<QcResult> = {}): QcResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    qcRunId: `qc-run-${Math.random().toString(36).slice(2, 8)}`,
    runId: "run-1",
    clusterId: "POL-TEST",
    trigger: "completed-cluster",
    provider: "coderabbit",
    providerMode: "local",
    startedAt: now,
    completedAt: now,
    status: "findings",
    findings: [],
    rawArtifactPaths: [],
    parserVersion: "coderabbit-1.0",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: false,
      routedToRepair: false,
      summary: "ok",
    },
    ...overrides,
  };
}

export function makeSameFileFindings(): QcFinding[] {
  return [
    makeFinding({
      findingId: "f-same-1",
      filePath: "src/auth/login.ts",
      category: "style",
      severity: "medium",
      range: { startLine: 10, endLine: 15 },
    }),
    makeFinding({
      findingId: "f-same-2",
      filePath: "src/auth/login.ts",
      category: "type-safety",
      severity: "medium",
      range: { startLine: 30, endLine: 35 },
    }),
    makeFinding({
      findingId: "f-same-3",
      filePath: "src/auth/login.ts",
      category: "style",
      severity: "medium",
      range: { startLine: 12, endLine: 16 },
    }),
  ];
}

export function makeCrossFileSubsystemFindings(): QcFinding[] {
  return [
    makeFinding({
      findingId: "f-sub-a",
      filePath: "src/qc/compiler.ts",
      category: "error-handling",
      severity: "medium",
      range: { startLine: 5, endLine: 8 },
    }),
    makeFinding({
      findingId: "f-sub-b",
      filePath: "src/qc/runner.ts",
      category: "error-handling",
      severity: "medium",
      range: { startLine: 20, endLine: 24 },
    }),
    makeFinding({
      findingId: "f-sub-c",
      filePath: "src/loop/worker.ts",
      category: "error-handling",
      severity: "medium",
      range: { startLine: 7, endLine: 11 },
    }),
  ];
}

export function makeOverlappingScopeFindings(): QcFinding[] {
  return [
    makeFinding({
      findingId: "f-overlap-1",
      filePath: "src/core/state.ts",
      category: "race-condition",
      severity: "high",
      range: { startLine: 40, endLine: 45 },
    }),
    makeFinding({
      findingId: "f-overlap-2",
      filePath: "src/core/state.ts",
      category: "race-condition",
      severity: "high",
      range: { startLine: 42, endLine: 48 },
    }),
  ];
}

export function makeHighRiskFindings(): QcFinding[] {
  return [
    makeFinding({
      findingId: "f-security-1",
      filePath: "src/auth/token.ts",
      category: "security",
      severity: "high",
      range: { startLine: 1, endLine: 5 },
    }),
    makeFinding({
      findingId: "f-security-2",
      filePath: "src/auth/token.ts",
      category: "auth",
      severity: "medium",
      range: { startLine: 10, endLine: 14 },
    }),
    makeFinding({
      findingId: "f-migration-1",
      filePath: "src/db/migrate.ts",
      category: "migration",
      severity: "medium",
      range: { startLine: 3, endLine: 7 },
    }),
  ];
}

export function makeLowConfidenceBroadFindings(): QcFinding[] {
  return [
    makeFinding({
      findingId: "f-broad-1",
      filePath: undefined,
      category: "architecture",
      severity: "medium",
      attribution: { confidence: "low", reason: "provider-uncertain" },
    }),
    makeFinding({
      findingId: "f-broad-2",
      filePath: undefined,
      category: "architecture",
      severity: "low",
      attribution: { confidence: "unattributed", reason: "unattributed" },
    }),
    makeFinding({
      findingId: "f-preexisting-1",
      filePath: "src/legacy/old.ts",
      category: "tech-debt",
      severity: "low",
      attribution: { confidence: "medium", reason: "pre-existing" },
    }),
  ];
}
