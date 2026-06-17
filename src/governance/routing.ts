import type {
  ClassificationResult,
  ReviewPacket,
  RoutingDecision,
  RoutingThresholds,
} from "./types.js";

function buildMinimalPacket(
  result: ClassificationResult,
  outcomeReason: string,
  recommendation: ReviewPacket["recommendation"],
): ReviewPacket {
  return {
    sourcePath: "",
    proposedDestination: "",
    classificationConfidence: result.classificationConfidence,
    destinationCertainty: result.destinationCertainty,
    authorityRisk: result.authorityRisk,
    reasoning: result.reasoning,
    conflicts: [],
    recommendation,
    outcomeReason,
  };
}

/**
 * Pure routing function — no I/O.
 * Implements the five-row governance decision table:
 *
 * Row 1: high conf + high dest + low risk  → auto-route
 * Row 2: high conf + high dest + med risk  → candidate
 * Row 3: high conf + low dest  + med risk  → review-required
 * Row 4: high conf + any dest  + high risk → review-required
 * Row 5: low conf  + any                   → review-required
 *
 * sourcePath and proposedDestination in the returned packet are empty strings;
 * the caller fills them in after routing.
 */
export function route(
  result: ClassificationResult,
  thresholds: RoutingThresholds,
): RoutingDecision {
  const highConf = result.classificationConfidence >= thresholds.confidence;
  const highDest = result.destinationCertainty >= thresholds.destinationCertainty;

  // Row 1
  if (highConf && highDest && result.authorityRisk === "low") {
    return { outcome: "auto-route" };
  }

  // Row 2
  if (highConf && highDest && result.authorityRisk === "medium") {
    return {
      outcome: "candidate",
      reviewPacket: buildMinimalPacket(
        result,
        "Routed to candidate: classification and destination certainty are high, but canonical approval is still required.",
        "approve",
      ),
    };
  }

  // Row 3
  if (highConf && !highDest && result.authorityRisk === "medium") {
    return {
      outcome: "review-required",
      reviewPacket: buildMinimalPacket(
        result,
        "Routed to review-required: destination certainty is below threshold for medium authority risk placement.",
        "defer",
      ),
    };
  }

  // Row 4
  if (highConf && result.authorityRisk === "high") {
    return {
      outcome: "review-required",
      reviewPacket: buildMinimalPacket(
        result,
        "Routed to review-required: high authority risk destination requires user approval.",
        "defer",
      ),
    };
  }

  // Row 5
  return {
    outcome: "review-required",
    reviewPacket: buildMinimalPacket(
      result,
      `Routed to review-required: classification confidence ${result.classificationConfidence.toFixed(2)} is below threshold ${thresholds.confidence}.`,
      "defer",
    ),
  };
}
