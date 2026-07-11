/**
 * Unit tests for routing anomaly signal classification.
 */

import { describe, expect, it } from "vitest";
import { classifyRoutingTelemetryEvent } from "./routing-signals.js";

describe("classifyRoutingTelemetryEvent", () => {
  it("returns undefined for unclassified telemetry events", () => {
    expect(classifyRoutingTelemetryEvent({ event: "worker-heartbeat" })).toBeUndefined();
    expect(classifyRoutingTelemetryEvent({ event: "provider-selected" })).toBeUndefined();
    expect(classifyRoutingTelemetryEvent({})).toBeUndefined();
  });

  it("classifies sealed-result-read-error as missing-sealed-result", () => {
    const signal = classifyRoutingTelemetryEvent({
      event: "sealed-result-read-error",
      child_id: "POL-100",
      error: "ENOENT",
    });
    expect(signal).toBeDefined();
    expect(signal!.signal).toBe("missing-sealed-result");
    expect(signal!.child_ids).toEqual(["POL-100"]);
    expect(signal!.occurrences).toBe(1);
  });

  it("classifies stale-dispatch-aborted as stale-dispatch-abort", () => {
    const signal = classifyRoutingTelemetryEvent({
      event: "stale-dispatch-aborted",
      child_id: "POL-101",
      reason: "no-acknowledgment",
    });
    expect(signal).toBeDefined();
    expect(signal!.signal).toBe("stale-dispatch-abort");
    expect(signal!.child_ids).toEqual(["POL-101"]);
  });

  it("classifies child-recovery-initiated with stale-dispatch as stale-dispatch-abort", () => {
    const signal = classifyRoutingTelemetryEvent({
      event: "child-recovery-initiated",
      child_id: "POL-102",
      recovery_reason: "stale-dispatch",
    });
    expect(signal).toBeDefined();
    expect(signal!.signal).toBe("stale-dispatch-abort");
  });

  it("ignores child-recovery-initiated with other reasons", () => {
    expect(
      classifyRoutingTelemetryEvent({
        event: "child-recovery-initiated",
        child_id: "POL-103",
        recovery_reason: "other",
      }),
    ).toBeUndefined();
  });

  it("classifies invalid-inline-attempt as invalid-inline-attempt", () => {
    const signal = classifyRoutingTelemetryEvent({
      event: "invalid-inline-attempt",
      child_id: "POL-104",
      reason: "child completion received without dispatch",
    });
    expect(signal).toBeDefined();
    expect(signal!.signal).toBe("invalid-inline-attempt");
    expect(signal!.child_ids).toEqual(["POL-104"]);
  });
});
