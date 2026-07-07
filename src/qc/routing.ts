/**
 * QC repair routing.
 *
 * Maps an attributed finding to one of four repair paths:
 *   - original-worker: hand back to the child that owns the change.
 *   - repair-worker: hand to a Medic-style repair worker (shared/unclear ownership).
 *   - follow-up: create a tracker follow-up issue (low severity, non-security).
 *   - operator-review: escalate to a human (high/critical, security, blocked auto-fix).
 */

import type { QcConfig } from "../config/schema.js";
import type { QcFinding, QcRoutingDecision, QcSeverity } from "./types.js";
import { isSecurityCategory } from "./security-category.js";
import { compareSeverity } from "./severity.js";

export interface RepairRoutingContext {
  /** Route name for per-route block threshold overrides. */
  routeName?: string;
}

function getBlockThreshold(config: QcConfig, context: RepairRoutingContext): QcSeverity {
  const route = context.routeName ? config.routes?.[context.routeName] : undefined;
  return route?.blockThreshold ?? config.severityThresholds?.block ?? "high";
}

/**
 * Decide the repair path for a finding.
 *
 * Rules (in order):
 *   1. High/critical findings or security-sensitive findings -> operator-review.
 *   2. Auto-fix eligible findings with clear attribution -> original-worker.
 *   3. Low severity -> follow-up issue.
 *   4. Shared ownership -> repair-worker.
 *   5. Unclear/weak attribution -> operator-review for medium+, follow-up for low/info.
 */
export function decideRepairRouting(
  finding: QcFinding,
  config: QcConfig,
  autofixEligible: boolean,
  context: RepairRoutingContext = {},
): QcRoutingDecision {
  const blockThreshold = getBlockThreshold(config, context);

  if (compareSeverity(finding.severity, blockThreshold) >= 0) {
    return "operator-review";
  }

  if (isSecurityCategory(finding.category)) {
    return "operator-review";
  }

  const attribution = finding.attribution;
  const clearAttribution = attribution.confidence === "high" || attribution.confidence === "medium";

  if (autofixEligible && clearAttribution && attribution.childId) {
    return "original-worker";
  }

  if (compareSeverity(finding.severity, "low") <= 0) {
    return "follow-up";
  }

  if (attribution.reason === "shared-file") {
    return "repair-worker";
  }

  if (attribution.confidence === "low" && attribution.reason === "provider-uncertain") {
    return attribution.childId ? "repair-worker" : "operator-review";
  }

  if (attribution.confidence === "unattributed") {
    return "operator-review";
  }

  return "repair-worker";
}
