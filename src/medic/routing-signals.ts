/**
 * Polaris routing anomaly → Medic/state-repair signal classification.
 *
 * These signals are emitted by the loop/dispatch/runtime boundary and are
 * reviewed by Medic, not used to mutate routing.
 */

import type { RoutingSignal } from "../types/result-packet.js";

export type { RoutingSignal };

/**
 * Map a raw telemetry event to a state-repair review signal.
 *
 * Only loop/dispatch boundary events that indicate runtime state-repair work
 * are classified. The returned signal has occurrences=1 and a single child_id;
 * consumers (such as SOL scoring) should aggregate by signal name.
 */
export function classifyRoutingTelemetryEvent(
  event: Record<string, unknown>,
): RoutingSignal | undefined {
  const eventName = event["event"];
  if (typeof eventName !== "string") return undefined;

  const childId = typeof event["child_id"] === "string" ? event["child_id"] : undefined;
  const childIds = childId ? [childId] : [];

  switch (eventName) {
    case "sealed-result-read-error":
      return {
        signal: "missing-sealed-result",
        reason: "missing-sealed-result",
        occurrences: 1,
        child_ids: childIds,
      };

    case "stale-dispatch-aborted":
      return {
        signal: "stale-dispatch-abort",
        reason: "stale-dispatch-abort",
        occurrences: 1,
        child_ids: childIds,
      };

    case "invalid-inline-attempt":
      return {
        signal: "invalid-inline-attempt",
        reason: "invalid-inline-attempt",
        occurrences: 1,
        child_ids: childIds,
      };

    case "child-recovery-initiated": {
      const recoveryReason = event["recovery_reason"];
      if (recoveryReason === "stale-dispatch") {
        return {
          signal: "stale-dispatch-abort",
          reason: "stale-dispatch",
          occurrences: 1,
          child_ids: childIds,
        };
      }
      return undefined;
    }

    default:
      return undefined;
  }
}
