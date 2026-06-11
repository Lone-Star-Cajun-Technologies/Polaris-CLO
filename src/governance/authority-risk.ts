import type { AuthorityRisk } from "./types.js";

const HIGH_AUTHORITY_PATH_SEGMENTS = [
  "doctrine/active",
  "architecture",
  "decisions",
  "specs/active",
];

const MEDIUM_AUTHORITY_PATH_SEGMENTS = [
  "doctrine/candidate",
];

const HIGH_AUTHORITY_CLASSIFICATIONS = new Set([
  "architecture",
  "decision",
  "spec-active",
]);

const MEDIUM_AUTHORITY_CLASSIFICATIONS = new Set([
  "doctrine-candidate",
]);

function riskFromPath(destinationPath: string): AuthorityRisk | null {
  const normalized = destinationPath.replace(/\\/g, "/");
  for (const seg of HIGH_AUTHORITY_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return "high";
  }
  for (const seg of MEDIUM_AUTHORITY_PATH_SEGMENTS) {
    if (normalized.includes(seg)) return "medium";
  }
  return null;
}

function riskFromClassification(classification: string): AuthorityRisk {
  if (HIGH_AUTHORITY_CLASSIFICATIONS.has(classification)) return "high";
  if (MEDIUM_AUTHORITY_CLASSIFICATIONS.has(classification)) return "medium";
  return "low";
}

/**
 * Determine the authority risk of placing a document at the given destination.
 * Path wins over classification when they disagree, because authority is
 * determined by where an artifact lands, not what it was classified as.
 */
export function computeAuthorityRisk(
  classification: string,
  destinationPath: string,
): AuthorityRisk {
  const pathRisk = riskFromPath(destinationPath);
  if (pathRisk !== null) return pathRisk;
  return riskFromClassification(classification);
}
