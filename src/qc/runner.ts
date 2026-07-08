/**
 * QC provider execution runner.
 *
 * Runs a provider-specific review command, classifies non-finding failures, and
 * normalizes the outcome into a Polaris QcResult with a durable providerAttempt
 * record. Supports optional fallback chains driven by per-provider failure policy.
 */

import { execFile, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { QcConfig, QcProviderConfig } from "../config/schema.js";
import type { IQcProvider, QcProviderOutput, QcProviderRegistry, QcReviewScope } from "./provider.js";
import { decideProviderFailureAction } from "./policy.js";
import type { QcFailureReason, QcProviderAttempt, QcResult } from "./types.js";

export interface QcRunnerOptions {
  repoRoot: string;
  runId: string;
  clusterId: string;
  branch?: string;
  telemetryFile?: string;
  timeoutMs?: number;
  execFileImpl?: typeof execFile;
  /** Full QC configuration used for failure policy and fallback lookup. */
  config?: QcConfig;
  /** Provider registry used when resolving fallback providers. */
  registry?: QcProviderRegistry;
}

function makeProviderAttempt(
  providerName: string,
  status: QcProviderAttempt["status"],
  output: QcProviderOutput,
  overrides?: Partial<QcProviderAttempt>,
): QcProviderAttempt {
  return {
    provider: providerName,
    status,
    rawOutputAvailable: (output.stdout?.length ?? 0) > 0 || (output.stderr?.length ?? 0) > 0,
    rawOutputRetained: false,
    stdoutLength: output.stdout?.length ?? 0,
    stderrLength: output.stderr?.length ?? 0,
    exitCode: output.exitCode,
    ...overrides,
  };
}

function makeSyntheticResult(
  provider: IQcProvider,
  scope: QcReviewScope,
  startedAt: string,
  status: QcResult["status"],
  summary: string,
  providerAttempt: QcProviderAttempt,
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
      blocksDelivery: status === "blocked" || status === "failed",
      requiresOperatorReview: status !== "passed" && status !== "skipped",
      routedToRepair: false,
      summary,
    },
    providerAttempt,
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

function resolveMode(scope: QcReviewScope): QcResult["providerMode"] {
  return scope.prUrl ? "pr" : "local";
}

function isModeSupported(provider: IQcProvider, scope: QcReviewScope): boolean {
  const mode = resolveMode(scope);
  return provider.supportedModes.includes(mode);
}

function getProviderConfig(name: string, config: QcConfig | undefined): QcProviderConfig | undefined {
  return config?.providers?.[name];
}

function classifyTerminalFailure(
  error: unknown,
  output: QcProviderOutput,
): QcFailureReason | undefined {
  const execError = error as
    | (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null })
    | null
    | undefined;

  if (execError?.killed && execError?.signal === "SIGTERM") {
    return "timeout";
  }

  if (execError?.code === "ENOENT") {
    return "command-not-found";
  }

  // Only scan output for failure keywords if the command actually failed
  if (!error && output.exitCode === 0) {
    return undefined;
  }

  const text = `${output.stdout ?? ""}\n${output.stderr ?? ""}`.toLowerCase();

  if (
    text.includes("rate limit") ||
    text.includes("429") ||
    text.includes("too many requests")
  ) {
    return "rate-limited";
  }

  if (
    text.includes("unauthorized") ||
    text.includes("authentication failed") ||
    text.includes("invalid token") ||
    text.includes("401") ||
    text.includes("forbidden") ||
    text.includes("403")
  ) {
    return "auth-failure";
  }

  if (
    text.includes("unavailable") ||
    text.includes("service unavailable") ||
    text.includes("503") ||
    text.includes("connection refused") ||
    text.includes("econnrefused")
  ) {
    return "unavailable-provider";
  }

  return undefined;
}

function classifyPostParseFailure(
  output: QcProviderOutput,
  parsed: QcResult,
): QcFailureReason | undefined {
  if (parsed.findings.length > 0) {
    return undefined;
  }

  const stdout = output.stdout ?? "";
  const stderr = output.stderr ?? "";

  if (stdout.trim().length === 0 && stderr.trim().length === 0) {
    if (output.exitCode !== 0) {
      return "empty-output";
    }
    return undefined;
  }

  if (output.exitCode !== 0) {
    return "nonzero-exit";
  }

  return undefined;
}

function emitProviderAttempted(
  telemetryFile: string | undefined,
  runId: string,
  clusterId: string,
  providerName: string,
  fallbackSource?: string,
): void {
  appendTelemetry(telemetryFile, {
    event: fallbackSource ? "qc-fallback-attempted" : "qc-provider-attempted",
    run_id: runId,
    cluster_id: clusterId,
    provider: providerName,
    fallback_source: fallbackSource,
    timestamp: new Date().toISOString(),
  });
}

function emitProviderFailed(
  telemetryFile: string | undefined,
  runId: string,
  clusterId: string,
  providerName: string,
  reason: QcFailureReason,
  exitCode?: number,
): void {
  appendTelemetry(telemetryFile, {
    event: "qc-provider-failed",
    run_id: runId,
    cluster_id: clusterId,
    provider: providerName,
    reason,
    exit_code: exitCode,
    timestamp: new Date().toISOString(),
  });
}

function emitFallbackSucceeded(
  telemetryFile: string | undefined,
  runId: string,
  clusterId: string,
  providerName: string,
  fallbackSource: string,
): void {
  appendTelemetry(telemetryFile, {
    event: "qc-fallback-succeeded",
    run_id: runId,
    cluster_id: clusterId,
    provider: providerName,
    fallback_source: fallbackSource,
    timestamp: new Date().toISOString(),
  });
}

function emitAllProvidersFailed(
  telemetryFile: string | undefined,
  runId: string,
  clusterId: string,
  attempted: string[],
): void {
  appendTelemetry(telemetryFile, {
    event: "qc-all-providers-failed",
    run_id: runId,
    cluster_id: clusterId,
    attempted_providers: attempted,
    timestamp: new Date().toISOString(),
  });
}

function buildFailedResult(
  provider: IQcProvider,
  scope: QcReviewScope,
  startedAt: string,
  reason: QcFailureReason,
  output: QcProviderOutput,
  overrides?: Partial<QcProviderAttempt>,
): QcResult {
  const providerAttempt = makeProviderAttempt(provider.name, "failure", output, {
    failureReason: reason,
    ...overrides,
  });
  return makeSyntheticResult(
    provider,
    scope,
    startedAt,
    "failed",
    `QC provider ${provider.name} failed: ${reason}`,
    providerAttempt,
  );
}

async function runSingleProvider(
  provider: IQcProvider,
  scope: QcReviewScope,
  options: QcRunnerOptions,
  fallbackSource?: string,
): Promise<{ result: QcResult; success: boolean }> {
  const startedAt = new Date().toISOString();
  const command = provider.buildReviewCommand(scope);
  const execFn = options.execFileImpl ?? execFile;
  const timeoutMs = options.timeoutMs ?? 300_000; // 5 minutes default
  const providerConfig = getProviderConfig(provider.name, options.config);

  emitProviderAttempted(options.telemetryFile, scope.runId, scope.clusterId, provider.name, fallbackSource);

  if (!isModeSupported(provider, scope)) {
    const output: QcProviderOutput = {
      provider: provider.name,
      exitCode: 1,
    };
    const result = buildFailedResult(provider, scope, startedAt, "unsupported-mode", output);
    emitProviderFailed(options.telemetryFile, scope.runId, scope.clusterId, provider.name, "unsupported-mode");
    return { result, success: false };
  }

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

        const output: QcProviderOutput = {
          provider: provider.name,
          stdout,
          stderr,
          exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        };

        const terminalReason = classifyTerminalFailure(error, output);
        if (terminalReason) {
          const result = buildFailedResult(provider, scope, startedAt, terminalReason, output);
          emitProviderFailed(
            options.telemetryFile,
            scope.runId,
            scope.clusterId,
            provider.name,
            terminalReason,
            output.exitCode,
          );
          resolve({ result, success: false });
          return;
        }

        // Empty output combined with a nonzero exit is an explicit failure.
        if (output.exitCode !== 0 && stdout.trim().length === 0 && stderr.trim().length === 0) {
          const result = buildFailedResult(provider, scope, startedAt, "empty-output", output);
          emitProviderFailed(
            options.telemetryFile,
            scope.runId,
            scope.clusterId,
            provider.name,
            "empty-output",
            output.exitCode,
          );
          resolve({ result, success: false });
          return;
        }

        // Empty success output is a valid "no findings" result.
        if (output.exitCode === 0 && stdout.trim().length === 0 && stderr.trim().length === 0) {
          const completedAt = new Date().toISOString();
          const result: QcResult = {
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
            status: "passed",
            findings: [],
            rawArtifactPaths: [],
            parserVersion: `${provider.name}-1.0`,
            policyDecision: {
              blocksDelivery: false,
              requiresOperatorReview: false,
              routedToRepair: false,
              summary: "No findings",
            },
            providerAttempt: makeProviderAttempt(provider.name, "success", output, {
              parserResult: "success",
            }),
          };
          appendTelemetry(options.telemetryFile, {
            event: "qc-provider-executed",
            run_id: scope.runId,
            cluster_id: scope.clusterId,
            provider: provider.name,
            trigger: result.trigger,
            status: result.status,
            findings_count: 0,
            exit_code: 0,
            timestamp: completedAt,
          });
          resolve({ result, success: true });
          return;
        }

        try {
          const parsed = provider.parse(output);
          const postParseReason = classifyPostParseFailure(output, parsed);
          if (postParseReason) {
            const result = buildFailedResult(provider, scope, startedAt, postParseReason, output);
            emitProviderFailed(
              options.telemetryFile,
              scope.runId,
              scope.clusterId,
              provider.name,
              postParseReason,
              output.exitCode,
            );
            resolve({ result, success: false });
            return;
          }

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
            providerAttempt: makeProviderAttempt(provider.name, "success", output, {
              parserResult: "success",
            }),
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

          resolve({ result, success: true });
        } catch (parseError) {
          const result = buildFailedResult(
            provider,
            scope,
            startedAt,
            "parse-failed",
            output,
            { parserResult: "failed" },
          );
          emitProviderFailed(
            options.telemetryFile,
            scope.runId,
            scope.clusterId,
            provider.name,
            "parse-failed",
            output.exitCode,
          );
          resolve({ result, success: false });
        }
      },
    );
  });
}

/**
 * Execute a provider review command for the given scope.
 *
 * Timeouts, parse failures, and other non-finding outcomes are normalized
 * into QcResult objects that carry a providerAttempt classification. When a
 * QcConfig and QcProviderRegistry are supplied, the runner follows each
 * provider's fallback list according to its failurePolicy.
 */
export async function executeQcProvider(
  provider: IQcProvider,
  scope: QcReviewScope,
  options: QcRunnerOptions,
): Promise<QcResult> {
  const visited = new Set<string>();
  const attempted: string[] = [];

  async function attemptChain(
    currentProvider: IQcProvider,
    fallbackSource?: string,
  ): Promise<{ result: QcResult; success: boolean; sourceProvider: string }> {
    if (visited.has(currentProvider.name)) {
      return {
        result: buildFailedResult(
          currentProvider,
          scope,
          new Date().toISOString(),
          "unavailable-provider",
          { provider: currentProvider.name, exitCode: 1 },
        ),
        success: false,
        sourceProvider: currentProvider.name,
      };
    }
    visited.add(currentProvider.name);
    attempted.push(currentProvider.name);

    const { result, success } = await runSingleProvider(currentProvider, scope, options, fallbackSource);
    if (success) {
      return { result, success, sourceProvider: currentProvider.name };
    }

    const providerConfig = getProviderConfig(currentProvider.name, options.config);
    const failureAction = decideProviderFailureAction(
      result.providerAttempt?.failureReason ?? "nonzero-exit",
      providerConfig?.failurePolicy,
    );

    if (failureAction === "ignore") {
      const skippedResult: QcResult = {
        ...result,
        status: "skipped",
        providerAttempt: result.providerAttempt
          ? { ...result.providerAttempt, status: "skipped" }
          : undefined,
        policyDecision: {
          ...result.policyDecision,
          blocksDelivery: false,
          requiresOperatorReview: false,
          summary: `QC provider ${currentProvider.name} skipped per failure policy`,
        },
      };
      return { result: skippedResult, success: true, sourceProvider: currentProvider.name };
    }

    if (failureAction === "block") {
      const blockedResult: QcResult = {
        ...result,
        status: "blocked",
        policyDecision: {
          ...result.policyDecision,
          blocksDelivery: true,
          summary: `QC provider ${currentProvider.name} blocked per failure policy`,
        },
      };
      return { result: blockedResult, success: false, sourceProvider: currentProvider.name };
    }

    if (failureAction !== "fallback" || !options.registry || !options.config) {
      return { result, success: false, sourceProvider: currentProvider.name };
    }

    const fallbackNames = providerConfig?.fallback ?? [];
    for (const fallbackName of fallbackNames) {
      const fallbackProvider = options.registry.get(fallbackName);
      if (!fallbackProvider) {
        attempted.push(fallbackName);
        continue;
      }
      const chainResult = await attemptChain(fallbackProvider, currentProvider.name);
      if (chainResult.success) {
        // Only emit telemetry and set fallbackSource if not already set by a deeper level
        const existingFallbackSource = chainResult.result.providerAttempt?.fallbackSource;
        if (!existingFallbackSource) {
          emitFallbackSucceeded(
            options.telemetryFile,
            scope.runId,
            scope.clusterId,
            chainResult.sourceProvider,
            currentProvider.name,
          );
        }
        const finalResult: QcResult = {
          ...chainResult.result,
          providerAttempt: chainResult.result.providerAttempt
            ? {
                ...chainResult.result.providerAttempt,
                fallbackSource: existingFallbackSource ?? currentProvider.name,
              }
            : undefined,
        };
        return { result: finalResult, success: true, sourceProvider: chainResult.sourceProvider };
      }
    }

    return { result, success: false, sourceProvider: currentProvider.name };
  }

  const { result, success, sourceProvider } = await attemptChain(provider);
  if (success) {
    return result;
  }

  // If the primary provider (or its fallback chain) failed and no fallback
  // succeeded, emit an all-providers-failed result and telemetry event when a
  // registry/config was supplied so the chain was actually resolvable.
  if (options.registry && options.config) {
    emitAllProvidersFailed(options.telemetryFile, scope.runId, scope.clusterId, attempted);
    const allFailedResult: QcResult = {
      ...result,
      status: "failed",
      allProvidersFailed: true,
      providerAttempt: result.providerAttempt
        ? { ...result.providerAttempt, status: "failure" }
        : undefined,
      policyDecision: {
        ...result.policyDecision,
        blocksDelivery: true,
        requiresOperatorReview: true,
        summary: `All QC providers failed for ${provider.name}`,
      },
    };
    return allFailedResult;
  }

  return result;
}
