import type { IQcProvider, QcMetricsPayload, QcProviderOutput, QcReviewScope } from "../provider.js";
import type { QcResult } from "../types.js";

/**
 * CodeRabbit-style QC adapter stub.
 *
 * This adapter documents the CodeRabbit capability surface without invoking
 * external services. Real network/CLI calls happen in downstream children that
 * own execution and credential handling.
 */
export class CodeRabbitQcProvider implements IQcProvider {
  readonly name = "coderabbit";
  readonly supportedModes = ["local", "pr"] as const;
  readonly capabilities = [
    "diff-review",
    "pr-review",
    "result-parsing",
    "auto-fix",
    "metrics-import",
  ] as const;

  canReview(scope: QcReviewScope): boolean {
    if (scope.prUrl) return true;
    return Boolean(scope.branch);
  }

  buildReviewCommand(scope: QcReviewScope): { command: string; args: string[] } {
    if (scope.prUrl) {
      return { command: "coderabbit", args: ["review", "--pr-url", scope.prUrl] };
    }
    return {
      command: "coderabbit",
      args: ["review", "--branch", scope.branch ?? "HEAD"],
    };
  }

  parse(output: QcProviderOutput): QcResult {
    const now = new Date().toISOString();
    return {
      schemaVersion: "1.0",
      qcRunId: `${output.provider}-${Date.now()}`,
      runId: "unknown",
      clusterId: "unknown",
      trigger: "completed-cluster",
      provider: output.provider,
      providerMode: "local",
      startedAt: now,
      completedAt: now,
      status: output.exitCode === 0 ? "passed" : "failed",
      findings: [],
      rawArtifactPaths: output.artifactPath ? [output.artifactPath] : [],
      parserVersion: "coderabbit-stub-1.0",
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: false,
        routedToRepair: false,
        summary: "CodeRabbit parsing not yet implemented; stub result only.",
      },
    };
  }

  importMetrics(payload: QcMetricsPayload): QcResult {
    const now = new Date().toISOString();
    return {
      schemaVersion: "1.0",
      qcRunId: `${payload.provider}-${Date.now()}`,
      runId: "unknown",
      clusterId: "unknown",
      trigger: "completed-cluster",
      provider: payload.provider,
      providerMode: "metrics-import",
      startedAt: now,
      completedAt: now,
      status: "skipped",
      findings: [],
      rawArtifactPaths: [],
      parserVersion: "coderabbit-metrics-stub-1.0",
      policyDecision: {
        blocksDelivery: false,
        requiresOperatorReview: false,
        routedToRepair: false,
        summary: "CodeRabbit metrics import not yet implemented; stub result only.",
      },
    };
  }
}
