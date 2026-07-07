/**
 * QC policy decision logic.
 *
 * Translates a normalized QC result and the Polaris QC configuration into an
 * explicit action for the loop/finalize lifecycle.
 */

import type { QcConfig } from "../config/schema.js";
import type { QcResult } from "./types.js";

/** Deterministic action applied to a QC result. */
export type QcPolicyAction = "pass" | "block" | "follow-up";

/**
 * Decide what the runtime should do with a QC result.
 *
 * Rules:
 *   - passed / skipped  → pass (no effect on delivery)
 *   - repairRouting: "block"  → block finalize/delivery
 *   - repairRouting: "log"    → pass (passive report only)
 *   - repairRouting: "route" / "follow-up" → create follow-up work
 *
 * Timeouts are surfaced as failed results and follow the same routing policy.
 */
export function decideQcAction(result: QcResult, config: QcConfig): QcPolicyAction {
  if (result.status === "passed" || result.status === "skipped") {
    return "pass";
  }

  const routing = config.repairRouting ?? "route";

  switch (routing) {
    case "block":
      return "block";
    case "log":
      return "pass";
    case "route":
    case "follow-up":
    default:
      return "follow-up";
  }
}
