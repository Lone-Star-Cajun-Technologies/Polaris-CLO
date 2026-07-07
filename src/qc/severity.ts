import type { QcSeverity } from "./types.js";

/**
 * Built-in severity label mappings for common QC providers.
 * Provider-specific configs can override these.
 */
export const DEFAULT_SEVERITY_MAPPING: Record<string, QcSeverity> = {
  // Common explicit labels
  critical: "critical",
  severe: "critical",
  blocker: "critical",
  high: "high",
  major: "high",
  error: "high",
  medium: "medium",
  moderate: "medium",
  warning: "medium",
  low: "low",
  minor: "low",
  info: "info",
  informational: "info",
  note: "info",
  suggestion: "info",
  // CodeRabbit-style labels
  "needs-action": "high",
  "needs-review": "medium",
  nitpick: "low",
};

/**
 * Normalize a provider severity label into a Polaris severity level.
 * Unknown or empty labels fall back to "info" so that nothing is silently lost.
 */
export function normalizeSeverity(
  label: string | null | undefined,
  mapping?: Record<string, QcSeverity>,
): QcSeverity {
  const raw = (label ?? "").toString().trim().toLowerCase();
  if (!raw) {
    return "info";
  }

  const combined: Record<string, QcSeverity> = { ...DEFAULT_SEVERITY_MAPPING, ...mapping };

  if (combined[raw]) {
    return combined[raw];
  }

  // Substring fallbacks for noisy provider labels
  if (raw.includes("critical") || raw.includes("severe") || raw.includes("blocker")) {
    return "critical";
  }
  if (raw.includes("high") || raw.includes("major") || raw.includes("error")) {
    return "high";
  }
  if (raw.includes("medium") || raw.includes("moderate") || raw.includes("warning")) {
    return "medium";
  }
  if (raw.includes("low") || raw.includes("minor") || raw.includes("nitpick")) {
    return "low";
  }
  if (raw.includes("info") || raw.includes("note") || raw.includes("suggestion")) {
    return "info";
  }

  return "info";
}

/** Ordered severity levels from least to most severe. */
export const SEVERITY_ORDER: QcSeverity[] = ["info", "low", "medium", "high", "critical"];

/**
 * Compare two severities. Returns negative if a is less severe than b,
 * positive if more severe, or zero if equal.
 */
export function compareSeverity(a: QcSeverity, b: QcSeverity): number {
  return SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b);
}

/**
 * Return the more severe of two severity levels.
 */
export function maxSeverity(a: QcSeverity, b: QcSeverity): QcSeverity {
  return compareSeverity(a, b) >= 0 ? a : b;
}
