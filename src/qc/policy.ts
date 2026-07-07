/**
 * QC policy decision logic.
 *
 * Translates a normalized QC result and the Polaris QC configuration into an
 * explicit action for the loop/finalize lifecycle. Findings with routing
 * decisions applied are used to determine whether delivery should block,
 * require operator review, or be routed to repair.
 */

import type { QcConfig } from "../config/schema.js";
import type { QcResult } from "./types.js";
import { compareSeverity } from "./severity.js";

/** Deterministic action applied to a QC result. */
export type QcPolicyAction = "pass" | "block" | "follow-up";

/**
 * Decide what the runtime should do with a QC result.
 *
 * Rules:
 *   - passed / skipped  -> pass (no effect on delivery)
 *   - repairRouting: "block"  -> block finalize/delivery
 *   - repairRouting: "log"    -> pass (passive report only)
 *   - repairRouting: "route" / "follow-up" -> create follow-up work, but high/critical
 *     findings still block according to severity thresholds.
 *
 * Timeouts are surfaced as failed results and follow the same routing policy.
 */
export function decideQcAction(result: QcResult, config: QcConfig): QcPolicyAction {
  if (result.status === "passed" || result.status === "skipped") {
    return "pass";
  }

  const routing = config.repairRouting ?? "route";

  if (routing === "block") {
    return "block";
  }

  if (routing === "log") {
    return "pass";
  }

  const blockThreshold = config.severityThresholds?.block ?? "high";
  const hasBlockingFinding = result.findings.some(
    (f) => compareSeverity(f.severity, blockThreshold) >= 0,
  );
  if (hasBlockingFinding) {
    return "block";
  }

  return "follow-up";
}

/**
 * Compute the detailed policy decision for a QC result after attribution and
 * repair routing have been applied.
 */
export function computeQcPolicyDecision(result: QcResult, config: QcConfig): QcResult["policyDecision"] {
  const blockThreshold = config.severityThresholds?.block ?? "high";

  const blocksDelivery = result.findings.some(
    (f) =>
      compareSeverity(f.severity, blockThreshold) >= 0 &&
      (f.routingDecision === "operator-review" || f.routingDecision === undefined),
  );

  const requiresOperatorReview =
    result.status === "failed" ||
    result.status === "blocked" ||
    result.findings.some((f) => f.routingDecision === "operator-review");
  const routedToRepair = result.findings.some(
    (f) => f.routingDecision === "original-worker" || f.routingDecision === "repair-worker",
  );

  const summaryParts: string[] = [];
  summaryParts.push(`${result.findings.length} findings`);
  if (requiresOperatorReview) {
    summaryParts.push("operator review required");
  }
  if (routedToRepair) {
    summaryParts.push("routed to repair");
  }

  return {
    blocksDelivery,
    requiresOperatorReview,
    routedToRepair,
    summary: summaryParts.join("; "),
  };
}
