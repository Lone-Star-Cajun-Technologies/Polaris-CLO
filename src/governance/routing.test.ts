import { describe, expect, it } from "vitest";
import { route } from "./routing.js";
import type { ClassificationResult, RoutingThresholds } from "./types.js";

const THRESHOLDS: RoutingThresholds = { confidence: 0.75, destinationCertainty: 0.70 };

function makeResult(overrides: Partial<ClassificationResult>): ClassificationResult {
  return {
    classification: "spec-raw",
    classificationConfidence: 0.8,
    destinationCertainty: 0.8,
    authorityRisk: "low",
    reasoning: [],
    ...overrides,
  };
}

describe("route", () => {
  it("auto-routes when high confidence, high destination certainty, low authority risk", () => {
    const result = route(makeResult({ authorityRisk: "low" }), THRESHOLDS);
    expect(result.outcome).toBe("auto-route");
    expect(result.reviewPacket).toBeUndefined();
  });

  it("routes to candidate when high confidence, high destination certainty, medium authority risk", () => {
    const result = route(
      makeResult({ authorityRisk: "medium", classificationConfidence: 0.9, destinationCertainty: 0.9 }),
      THRESHOLDS,
    );
    expect(result.outcome).toBe("candidate");
    expect(result.reviewPacket).toBeDefined();
    expect(result.reviewPacket?.recommendation).toBe("approve");
  });

  it("routes to review-required when high confidence, low destination certainty, medium authority risk", () => {
    const result = route(
      makeResult({ authorityRisk: "medium", classificationConfidence: 0.9, destinationCertainty: 0.5 }),
      THRESHOLDS,
    );
    expect(result.outcome).toBe("review-required");
    expect(result.reviewPacket).toBeDefined();
  });

  it("routes to review-required when high confidence, high destination certainty, high authority risk", () => {
    const result = route(
      makeResult({ authorityRisk: "high", classificationConfidence: 0.95, destinationCertainty: 0.95 }),
      THRESHOLDS,
    );
    expect(result.outcome).toBe("review-required");
    expect(result.reviewPacket).toBeDefined();
  });

  it("routes to review-required when low classification confidence", () => {
    const result = route(
      makeResult({ classificationConfidence: 0.4, authorityRisk: "low" }),
      THRESHOLDS,
    );
    expect(result.outcome).toBe("review-required");
  });

  it("routes to review-required when low classification confidence regardless of authority risk", () => {
    const result = route(
      makeResult({ classificationConfidence: 0.4, authorityRisk: "high" }),
      THRESHOLDS,
    );
    expect(result.outcome).toBe("review-required");
  });

  it("review packet includes outcomeReason", () => {
    const result = route(makeResult({ authorityRisk: "high" }), THRESHOLDS);
    expect(result.reviewPacket?.outcomeReason).toMatch(/high authority risk/i);
  });

  it("review packet for candidate includes outcomeReason explaining why", () => {
    const result = route(
      makeResult({ authorityRisk: "medium", classificationConfidence: 0.9, destinationCertainty: 0.9 }),
      THRESHOLDS,
    );
    expect(result.reviewPacket?.outcomeReason).toMatch(/candidate/i);
  });
});
