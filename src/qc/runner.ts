/**
 * QC provider execution runner.
 *
 * Runs a provider-specific review command, handles timeouts, and normalizes
 * the raw output into a Polaris QcResult with runtime fields populated.
 */

import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IQcProvider, QcProviderOutput, QcReviewScope } from "./provider.js";
import type { QcResult } from "./types.js";

export interface QcRunnerOptions {
  repoRoot: string;
  runId: string;
  clusterId: string;
  branch?: string;
  telemetryFile?: string;
  timeoutMs?: number;
  execFileImpl?: typeof execFile;
}

function makeSyntheticResult(
  provider: IQcProvider,
  scope: QcReviewScope,
  startedAt: string,
  status: QcResult["status"],
  summary: string,
): QcResult {
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    qcRunId: `${provider.name}-${Date.now()}`,
    runId: scope.runId,
    clusterId: scope.clusterId,
    trigger: scope.prUrl ? "pr" : "completed-cluster",
    provider: provider.name,
    providerMode: scope.prUrl ? "pr" : "local",
    prUrl: scope.prUrl,
    startedAt,
    completedAt,
    status,
    findings: [],
    rawArtifactPaths: [],
    parserVersion: `${provider.name}-synthetic`,
    policyDecision: {
      blocksDelivery: false,
      requiresOperatorReview: status !== "passed",
      routedToRepair: false,
      summary,
    },
  };
}

function appendTelemetry(telemetryFile: string | undefined, event: Record<string, unknown>): void {
  if (!telemetryFile) return;
  try {
    mkdirSync(dirname(telemetryFile), { recursive: true });
    appendFileSync(telemetryFile, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // Telemetry is best-effort.
  }
}

function resolveExecutionFailure(
  provider: IQcProvider,
  scope: QcReviewScope,
  options: QcRunnerOptions,
  startedAt: string,
  output: QcProviderOutput,
  reason: string,
): QcResult {
  const result = makeSyntheticResult(provider, scope, startedAt, "failed", reason);
  appendTelemetry(options.telemetryFile, {
    event: "qc-provider-execution-failed",
    run_id: scope.runId,
    cluster_id: scope.clusterId,
    provider: provider.name,
    exit_code: output.exitCode,
    reason,
    timestamp: result.completedAt,
  });
  return result;
}

/**
 * Execute a provider review command for the given scope.
 *
 * Timeouts produce a synthetic "failed" result so that policy logic downstream
 * can decide whether to block, follow-up, or report passively.
 */
export async function executeQcProvider(
  provider: IQcProvider,
  scope: QcReviewScope,
  options: QcRunnerOptions,
): Promise<QcResult> {
  const startedAt = new Date().toISOString();
  const command = provider.buildReviewCommand(scope);
  const execFn = options.execFileImpl ?? execFile;
  const timeoutMs = options.timeoutMs ?? 300_000; // 5 minutes default

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child: ChildProcess = execFn(
      command.command,
      command.args,
      {
        cwd: options.repoRoot,
        timeout: timeoutMs,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      } as ExecFileOptions,
      (error, out, err) => {
        stdout = (out as string | null) ?? "";
        stderr = (err as string | null) ?? "";

        // Detect timeout: execFile kills with SIGTERM on timeout.
        if (error && error.killed && error.signal === "SIGTERM") {
          const result = makeSyntheticResult(
            provider,
            scope,
            startedAt,
            "failed",
            `QC provider ${provider.name} timed out after ${timeoutMs}ms`,
          );
          appendTelemetry(options.telemetryFile, {
            event: "qc-provider-timeout",
            run_id: scope.runId,
            cluster_id: scope.clusterId,
            provider: provider.name,
            timeout_ms: timeoutMs,
            timestamp: new Date().toISOString(),
          });
          resolve(result);
          return;
        }

        const output: QcProviderOutput = {
          provider: provider.name,
          stdout,
          stderr,
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        };

        try {
          const parsed = provider.parse(output);
          const completedAt = new Date().toISOString();

          const result: QcResult = {
            ...parsed,
            qcRunId: `${provider.name}-${Date.now()}`,
            runId: scope.runId,
            clusterId: scope.clusterId,
            trigger: scope.prUrl ? "pr" : scope.branch ? "completed-cluster" : "child",
            provider: provider.name,
            providerMode: scope.prUrl ? "pr" : "local",
            prUrl: scope.prUrl,
            startedAt,
            completedAt,
          };

          appendTelemetry(options.telemetryFile, {
            event: "qc-provider-executed",
            run_id: scope.runId,
            cluster_id: scope.clusterId,
            provider: provider.name,
            trigger: result.trigger,
            status: result.status,
            findings_count: result.findings.length,
            exit_code: output.exitCode,
            timestamp: completedAt,
          });

          resolve(result);
        } catch (parseError) {
          resolve(
            resolveExecutionFailure(
              provider,
              scope,
              options,
              startedAt,
              output,
              `QC provider ${provider.name} parse failed: ${
                parseError instanceof Error ? parseError.message : String(parseError)
              }`,
            ),
          );
        }
      },
    );
  });
}
