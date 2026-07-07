/**
 * QC trigger orchestration.
 *
 * Wires QC providers into the Polaris lifecycle at:
 *   - completed-cluster (after all children done, before final delivery)
 *   - pr (after a PR is created, for providers that require a PR URL)
 *   - child (selected at dispatch time for high-risk scopes)
 *
 * The orchestrator is passive/dry-run by default; only configured providers
 * are invoked, and only blocking policy stops the loop/finalize flow.
 */

import type { QcConfig } from "../config/schema.js";
import { readClusterStateSync, recordQcRun } from "../cluster-state/store.js";
import type { LoopState } from "../loop/checkpoint.js";
import type { QcProviderRegistry } from "./provider.js";
import type { QcReviewScope } from "./provider.js";
import type { QcResult } from "./types.js";
import { decideQcAction, computeQcPolicyDecision, type QcPolicyAction } from "./policy.js";
import { executeQcProvider, type QcRunnerOptions } from "./runner.js";
import { activeProvidersForTrigger } from "./triggers.js";
import { buildChangedFileOwnership, resolveAttributionWithOwnership, type QcAttributionContext } from "./attribution.js";
import { isAutofixEligible } from "./autofix.js";
import { decideRepairRouting } from "./routing.js";

export interface QcOrchestratorResult {
  /** Trigger that was evaluated. */
  trigger: "pr" | "completed-cluster" | "child";
  /** Results from each invoked provider. */
  results: QcResult[];
  /** Deterministic policy action for the runtime. */
  action: QcPolicyAction;
  /** Human-readable summary for logs/telemetry. */
  summary: string;
}

export interface RunQcAtTriggerOptions extends QcRunnerOptions {
  config: QcConfig;
  registry: QcProviderRegistry;
  trigger: "pr" | "completed-cluster" | "child";
  /** Required for the "pr" trigger. */
  prUrl?: string;
  /** Optional loop state for attribution evidence. */
  state?: LoopState;
  /** Optional route name for per-route policy overrides. */
  routeName?: string;
}

function buildAttributionContext(options: RunQcAtTriggerOptions): QcAttributionContext {
  const { repoRoot, clusterId, branch, state } = options;
  const dispatchRecords: Record<string, import("../loop/checkpoint.js").ChildDispatchRecord> = {};
  if (state?.open_children_meta) {
    for (const [childId, meta] of Object.entries(state.open_children_meta)) {
      if (meta?.dispatch_record) {
        dispatchRecords[childId] = meta.dispatch_record;
      }
    }
  }

  return {
    repoRoot,
    baseBranch: branch ?? state?.branch ?? "main",
    completedResults: state?.completed_children_results,
    dispatchRecords,
    clusterState: repoRoot ? (readClusterStateSync(clusterId, repoRoot) ?? undefined) : undefined,
  };
}

function applyAttributionAndRouting(
  result: QcResult,
  config: QcConfig,
  context: QcAttributionContext,
  ownership: Record<string, string[]>,
  routeName?: string,
): QcResult {
  const updatedFindings = result.findings.map((finding) => {
    const attribution = resolveAttributionWithOwnership(finding, context, ownership);
    const autofix = isAutofixEligible(finding, config, {
      provider: result.provider,
      routeName,
    });
    const routing = decideRepairRouting(
      { ...finding, attribution, autofixEligible: autofix.eligible },
      config,
      autofix.eligible,
      { routeName },
    );
    return {
      ...finding,
      attribution,
      autofixEligible: autofix.eligible,
      routingDecision: routing,
    };
  });

  const updatedResult: QcResult = {
    ...result,
    findings: updatedFindings,
    policyDecision: computeQcPolicyDecision({ ...result, findings: updatedFindings }, config),
  };
  return updatedResult;
}

/**
 * Run QC for the given lifecycle trigger when configured.
 *
 * Returns a no-op "pass" result when QC is disabled, no providers are configured
 * for the trigger, or all providers run successfully without findings that
 * match a blocking/follow-up policy.
 */
export async function runQcAtTrigger(
  options: RunQcAtTriggerOptions,
): Promise<QcOrchestratorResult> {
  const {
    config,
    registry,
    trigger,
    prUrl,
    repoRoot,
    runId,
    clusterId,
    branch,
    telemetryFile,
    timeoutMs,
    state,
    routeName,
  } = options;

  if (!config.enabled) {
    return {
      trigger,
      results: [],
      action: "pass",
      summary: "QC disabled by configuration",
    };
  }

  const providers = activeProvidersForTrigger(config, trigger);
  if (providers.length === 0) {
    return {
      trigger,
      results: [],
      action: "pass",
      summary: `No QC providers configured for trigger "${trigger}"`,
    };
  }

  const attributionContext = buildAttributionContext(options);
  const ownership = buildChangedFileOwnership(attributionContext);

  const results: QcResult[] = [];
  const errors: string[] = [];

  for (const [name, providerConfig] of providers) {
    const provider = registry.get(name);
    if (!provider) {
      errors.push(`Unknown QC provider "${name}"`);
      continue;
    }

    const scope: QcReviewScope = {
      clusterId,
      runId,
      ...(trigger === "pr" ? { prUrl } : { branch }),
    };

    try {
      const rawResult = await executeQcProvider(provider, scope, {
        repoRoot,
        runId,
        clusterId,
        branch,
        telemetryFile,
        timeoutMs,
      });

      const result = applyAttributionAndRouting(rawResult, config, attributionContext, ownership, routeName);

      try {
        await recordQcRun(clusterId, result, repoRoot);
      } catch (err) {
        errors.push(
          `Failed to record QC run ${result.qcRunId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      results.push(result);
    } catch (err) {
      errors.push(
        `QC provider "${name}" execution error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let action: QcPolicyAction = "pass";
  for (const result of results) {
    const a = decideQcAction(result, config);
    if (a === "block") {
      action = "block";
      break;
    }
    if (a === "follow-up" && action === "pass") {
      action = "follow-up";
    }
  }
  const successfulRuns = results.filter((result) => result.status !== "failed");
  if (action === "pass" && successfulRuns.length === 0 && (results.length > 0 || errors.length > 0)) {
    action = "block";
  }

  const summaryParts = results.map(
    (r) => `${r.provider}: ${r.status} (${r.findings.length} findings)`,
  );
  if (errors.length > 0) {
    summaryParts.push(`errors: ${errors.join(", ")}`);
  }

  return {
    trigger,
    results,
    action,
    summary: summaryParts.join("; ") || "No QC providers produced results",
  };
}
