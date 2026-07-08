import { describe, expect, it } from "vitest";
import { validateQcFinding, validateQcResult } from "./schemas.js";
import type { QcFinding, QcResult } from "./types.js";

function makeValidFinding(overrides?: Partial<QcFinding>): QcFinding {
  return {
    findingId: "f-1",
    severity: "high",
    title: "A finding",
    fixAvailable: false,
    autofixEligible: false,
    attribution: { confidence: "unattributed", reason: "provider-uncertain" },
    status: "open",
    ...overrides,
  };
}

function makeValidResult(overrides?: Partial<QcResult>): QcResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    qcRunId: "qc-1",
    runId: "run-1",
    clusterId: "POL-1",
    trigger: "completed-cluster",
    provider: "coderabbit",
    providerMode: "local",
    startedAt: now,
    completedAt: now,
    status: "passed",
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

describe("validateQcResult", () => {
  it("accepts a valid QC result", () => {
    const result = validateQcResult(makeValidResult());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.clusterId).toBe("POL-1");
    }
  });

  it("rejects a result missing required fields", () => {
    const result = validateQcResult({ provider: "coderabbit" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it("rejects an invalid trigger value", () => {
    const result = validateQcResult(makeValidResult({ trigger: "invalid" as QcResult["trigger"] }));
    expect(result.success).toBe(false);
  });

  it("rejects a malformed ISO timestamp", () => {
    const result = validateQcResult(makeValidResult({ startedAt: "yesterday" }));
    expect(result.success).toBe(false);
  });

  it("accepts a result with findings", () => {
    const result = validateQcResult(
      makeValidResult({
        status: "findings",
        findings: [makeValidFinding()],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts a result with providerAttempt and allProvidersFailed", () => {
    const result = validateQcResult(
      makeValidResult({
        status: "failed",
        allProvidersFailed: true,
        providerAttempt: {
          provider: "test",
          status: "failure",
          failureReason: "parse-failed",
          rawOutputAvailable: true,
          rawOutputRetained: false,
          stdoutLength: 10,
          stderrLength: 0,
        },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.allProvidersFailed).toBe(true);
      expect(result.result.providerAttempt?.failureReason).toBe("parse-failed");
    }
  });

  it("rejects an invalid providerAttempt failureReason", () => {
    const result = validateQcResult(
      makeValidResult({
        providerAttempt: {
          provider: "test",
          status: "failure",
          failureReason: "unknown-reason",
          rawOutputAvailable: true,
          rawOutputRetained: false,
          stdoutLength: 0,
          stderrLength: 0,
        } as unknown as import("./types.js").QcProviderAttempt,
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe("validateQcFinding", () => {
  it("accepts a valid finding", () => {
    const result = validateQcFinding(makeValidFinding());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.finding.severity).toBe("high");
    }
  });

  it("rejects a finding with invalid severity", () => {
    const result = validateQcFinding(makeValidFinding({ severity: "urgent" as QcFinding["severity"] }));
    expect(result.success).toBe(false);
  });

  it("rejects a finding with out-of-range confidence", () => {
    const result = validateQcFinding(makeValidFinding({ confidence: 1.5 }));
    expect(result.success).toBe(false);
  });

  it("rejects a finding missing required attribution", () => {
    const result = validateQcFinding({ findingId: "f-1", severity: "high", title: "x", fixAvailable: false, autofixEligible: false, status: "open" } as QcFinding);
    expect(result.success).toBe(false);
  });
});
