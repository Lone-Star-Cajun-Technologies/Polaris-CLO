/**
 * Shared types for document governance decisions: authority risk assessment, routing,
 * and review packets. Intentionally decoupled from Smart Docs vocabulary so this module
 * can be reused by any Polaris workflow that requires authority-boundary enforcement.
 * The `classification` field is opaque (string) — callers define their own vocabulary.
 */

export type AuthorityRisk = "low" | "medium" | "high";
export type ReviewRecommendation = "approve" | "reject" | "defer";
export type RoutingOutcome = "auto-route" | "candidate" | "review-required";

export interface ClassificationResult {
  /** Opaque classification string — the caller defines the vocabulary. */
  classification: string;
  /** Confidence that the classification is correct. Clamped 0.0–1.0. */
  classificationConfidence: number;
  /** Confidence that the proposed destination is correct. Clamped 0.0–1.0. */
  destinationCertainty: number;
  authorityRisk: AuthorityRisk;
  /** Human-readable signals that drove the classification. */
  reasoning: string[];
}

export interface RoutingThresholds {
  confidence: number;
  destinationCertainty: number;
}

export interface ReviewPacket {
  sourcePath: string;
  proposedDestination: string;
  classificationConfidence: number;
  destinationCertainty: number;
  authorityRisk: AuthorityRisk;
  reasoning: string[];
  conflicts: string[];
  recommendation: ReviewRecommendation;
  /** Plain-English explanation of why this outcome was chosen. */
  outcomeReason: string;
  // Populated after human review:
  reviewDecision?: ReviewRecommendation;
  reviewedAt?: string;
  reviewedBy?: string;
}

export interface RoutingDecision {
  outcome: RoutingOutcome;
  reviewPacket?: ReviewPacket;
}
