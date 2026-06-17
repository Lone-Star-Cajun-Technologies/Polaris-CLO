import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AuthorityRisk,
  ClassificationResult,
  ReviewPacket,
  ReviewRecommendation,
} from "./types.js";

export function buildReviewPacket(
  result: ClassificationResult,
  sourcePath: string,
  proposedDestination: string,
  conflicts: string[],
  outcomeReason: string,
  recommendation: ReviewRecommendation,
): ReviewPacket {
  return {
    sourcePath,
    proposedDestination,
    classificationConfidence: result.classificationConfidence,
    destinationCertainty: result.destinationCertainty,
    authorityRisk: result.authorityRisk,
    reasoning: result.reasoning,
    conflicts,
    recommendation,
    outcomeReason,
  };
}

interface ReviewQueueFile {
  generated_at: string;
  run_id: string;
  packets: ReviewPacket[];
}

const RISK_ORDER: Record<AuthorityRisk, number> = { high: 0, medium: 1, low: 2 };

function renderPacketMarkdown(p: ReviewPacket): string {
  const lines: string[] = [
    `## ${p.reviewDecision ? `✓ ${p.reviewDecision}` : "review-required"} · ${p.authorityRisk.toUpperCase()} authority risk`,
    ``,
    `**Source:** ${p.sourcePath}`,
    `**Proposed destination:** ${p.proposedDestination}`,
    `**Classification confidence:** ${p.classificationConfidence.toFixed(2)}`,
    `**Destination certainty:** ${p.destinationCertainty.toFixed(2)}`,
    `**Outcome reason:** ${p.outcomeReason}`,
    ``,
    `**Reasoning:**`,
    ...p.reasoning.map((r) => `- ${r}`),
    ``,
    `**Conflicts:** ${p.conflicts.length === 0 ? "none detected" : p.conflicts.join(", ")}`,
    ``,
    `**Recommendation:** ${p.recommendation}`,
    `**Review decision:** ${p.reviewDecision ?? "← set this to \`approve\`, \`reject\`, or \`defer\`"}`,
  ];
  return lines.join("\n");
}

function groupAndSort(packets: ReviewPacket[]): ReviewPacket[] {
  return [...packets].sort((a, b) => {
    const riskCompare = RISK_ORDER[a.authorityRisk] - RISK_ORDER[b.authorityRisk];
    if (riskCompare !== 0) return riskCompare;
    return a.sourcePath.localeCompare(b.sourcePath);
  });
}

/**
 * Write _review-queue.json (canonical) and _review-queue.md (display-only) to outputDir.
 * Markdown is regenerated from JSON — never parse markdown to recover decisions.
 */
export function writeReviewQueue(
  packets: ReviewPacket[],
  runId: string,
  outputDir: string,
  filename = "_review-queue.json",
): void {
  mkdirSync(outputDir, { recursive: true });

  const queueFile: ReviewQueueFile = {
    generated_at: new Date().toISOString(),
    run_id: runId,
    packets,
  };

  writeFileSync(
    join(outputDir, filename),
    JSON.stringify(queueFile, null, 2) + "\n",
    "utf-8",
  );

  const mdFilename = filename.replace(/\.json$/, ".md");
  const sorted = groupAndSort(packets);
  const sections = sorted.map(renderPacketMarkdown).join("\n\n---\n\n");
  const md = [
    `# Polaris Review Queue`,
    ``,
    `**Run ID:** ${runId}`,
    `**Generated:** ${queueFile.generated_at}`,
    `**Pending review:** ${packets.length} document(s)`,
    ``,
    `> Markdown is display-only. Edit \`${filename}\` to set \`reviewDecision\` fields.`,
    `> Rerun \`polaris docs ingest\` to apply decisions.`,
    ``,
    `---`,
    ``,
    sections,
  ].join("\n");

  writeFileSync(join(outputDir, mdFilename), md, "utf-8");
}

/**
 * Read review queue from JSON. Returns empty array if no queue file exists.
 * Never reads markdown.
 */
export function readReviewQueue(outputDir: string, filename = "_review-queue.json"): ReviewPacket[] {
  const jsonPath = join(outputDir, filename);
  if (!existsSync(jsonPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf-8")) as ReviewQueueFile;
    return Array.isArray(parsed.packets) ? parsed.packets : [];
  } catch {
    return [];
  }
}

/**
 * Merge user decisions from a reviewed queue into a set of pending packets.
 * Matches by sourcePath. Unmatched pending packets are returned unchanged.
 */
export function applyReviewDecisions(
  pending: ReviewPacket[],
  reviewed: ReviewPacket[],
): ReviewPacket[] {
  const bySource = new Map(reviewed.map((r) => [r.sourcePath, r]));
  return pending.map((p) => {
    const decision = bySource.get(p.sourcePath);
    if (!decision?.reviewDecision) return p;
    return {
      ...p,
      reviewDecision: decision.reviewDecision,
      reviewedAt: decision.reviewedAt,
      reviewedBy: decision.reviewedBy,
    };
  });
}
