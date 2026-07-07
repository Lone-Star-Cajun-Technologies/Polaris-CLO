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
import { recordQcRun } from "../cluster-state/store.js";
import type { QcProviderRegistry } from "./provider.js";
import type { QcReviewScope } from "./provider.js";
import type { QcResult } from "./types.js";
import { decideQcAction, type QcPolicyAction } from "./policy.js";
import { executeQcProvider, type QcRunnerOptions } from "./runner.js";
import { activeProvidersForTrigger } from "./triggers.js";

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
      const result = await executeQcProvider(provider, scope, {
        repoRoot,
        runId,
        clusterId,
        branch,
        telemetryFile,
        timeoutMs,
      });

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
