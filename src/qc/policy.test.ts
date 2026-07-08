import { describe, it, expect } from "vitest";
import { decideProviderFailureAction, decideQcAction, computeQcPolicyDecision } from "./policy.js";
import type { QcConfig } from "../config/schema.js";
import type { QcResult } from "./types.js";

function makeResult(overrides?: Partial<QcResult>): QcResult {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    qcRunId: "qc-1",
    runId: "run-1",
    clusterId: "POL-1",
    trigger: "completed-cluster",
    provider: "test",
    providerMode: "local",
    startedAt: now,
    completedAt: now,
    status: "failed",
    findings: [],
    rawArtifactPaths: [],
    parserVersion: "test-1.0",
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: true,
      routedToRepair: false,
      summary: "failed",
    },
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<QcConfig>): QcConfig {
  return {
    enabled: true,
    defaultTrigger: "completed-cluster",
    providers: {},
    severityThresholds: { block: "high", repair: "medium", followUp: "low" },
    autoFix: "disabled",
    repairRouting: "route",
    artifactRetention: { retainRawOutput: false, maxRuns: 10 },
    routes: {},
    ...overrides,
  };
}

describe("decideProviderFailureAction", () => {
  it("uses the configured timeout policy", () => {
    expect(
      decideProviderFailureAction("timeout", { timeout: "fallback" }),
    ).toBe("fallback");
  });

  it("uses the configured parseFailure policy", () => {
    expect(
      decideProviderFailureAction("parse-failed", { parseFailure: "ignore" }),
    ).toBe("ignore");
  });

  it("defaults unknown reasons to fail", () => {
    expect(
      decideProviderFailureAction("nonzero-exit", { timeout: "fallback" }),
    ).toBe("fail");
    expect(
      decideProviderFailureAction("command-not-found", {}),
    ).toBe("fail");
  });
});

describe("decideQcAction", () => {
  it("passes for passed results", () => {
    expect(decideQcAction(makeResult({ status: "passed" }), makeConfig())).toBe("pass");
  });

  it("passes for skipped results", () => {
    expect(decideQcAction(makeResult({ status: "skipped" }), makeConfig())).toBe("pass");
  });

  it("blocks when allProvidersFailed is true", () => {
    expect(decideQcAction(makeResult({ allProvidersFailed: true }), makeConfig())).toBe("block");
  });

  it("blocks when repairRouting is block", () => {
    expect(
      decideQcAction(makeResult({ status: "findings" }), makeConfig({ repairRouting: "block" })),
    ).toBe("block");
  });

  it("passes when repairRouting is log", () => {
    expect(
      decideQcAction(makeResult({ status: "findings" }), makeConfig({ repairRouting: "log" })),
    ).toBe("pass");
  });

  it("blocks when a finding meets the block threshold", () => {
    const result = makeResult({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "high",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
    });
    expect(decideQcAction(result, makeConfig())).toBe("block");
  });

  it("routes to follow-up for non-blocking findings", () => {
    const result = makeResult({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "low",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
    });
    expect(decideQcAction(result, makeConfig())).toBe("follow-up");
  });
});

describe("computeQcPolicyDecision", () => {
  it("blocks delivery when allProvidersFailed is true", () => {
    const result = computeQcPolicyDecision(makeResult({ allProvidersFailed: true }), makeConfig());
    expect(result.blocksDelivery).toBe(true);
    expect(result.requiresOperatorReview).toBe(true);
    expect(result.summary).toContain("all providers failed");
  });

  it("blocks delivery for high/critical findings", () => {
    const result = makeResult({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "high",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
    });
    const decision = computeQcPolicyDecision(result, makeConfig());
    expect(decision.blocksDelivery).toBe(true);
    expect(decision.requiresOperatorReview).toBe(false);
  });

  it("does not block delivery for low findings", () => {
    const result = makeResult({
      status: "findings",
      findings: [
        {
          findingId: "f-1",
          severity: "low",
          title: "Issue",
          fixAvailable: false,
          autofixEligible: false,
          attribution: { confidence: "unattributed", reason: "provider-uncertain" },
          status: "open",
        },
      ],
    });
    const decision = computeQcPolicyDecision(result, makeConfig());
    expect(decision.blocksDelivery).toBe(false);
    expect(decision.requiresOperatorReview).toBe(false);
  });

  it("requires operator review for failed provider results", () => {
    const result = makeResult({ status: "failed" });
    const decision = computeQcPolicyDecision(result, makeConfig());
    expect(decision.requiresOperatorReview).toBe(true);
  });
});
