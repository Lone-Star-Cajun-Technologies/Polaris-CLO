import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  buildReviewPacket,
  writeReviewQueue,
  readReviewQueue,
  applyReviewDecisions,
} from "./review-packet.js";
import type { ClassificationResult, ReviewPacket } from "./types.js";

function makeResult(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    classification: "doctrine-candidate",
    classificationConfidence: 0.82,
    destinationCertainty: 0.65,
    authorityRisk: "high",
    reasoning: ["frontmatter authority: doctrine", "contains must-never assertions (3 matches)"],
    ...overrides,
  };
}

describe("buildReviewPacket", () => {
  it("builds a packet with all required fields", () => {
    const packet = buildReviewPacket(
      makeResult(),
      "docs/auth.md",
      "smartdocs/doctrine/active/auth.md",
      [],
      "High authority risk destination requires user approval.",
      "defer",
    );
    expect(packet.sourcePath).toBe("docs/auth.md");
    expect(packet.proposedDestination).toBe("smartdocs/doctrine/active/auth.md");
    expect(packet.classificationConfidence).toBe(0.82);
    expect(packet.authorityRisk).toBe("high");
    expect(packet.recommendation).toBe("defer");
    expect(packet.outcomeReason).toMatch(/authority risk/i);
    expect(packet.reviewDecision).toBeUndefined();
  });
});

describe("writeReviewQueue / readReviewQueue", () => {
  it("writes JSON and markdown, reads back packets from JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-gov-"));
    const packets: ReviewPacket[] = [
      buildReviewPacket(
        makeResult(),
        "docs/auth.md",
        "smartdocs/doctrine/active/auth.md",
        [],
        "High authority risk.",
        "defer",
      ),
    ];

    writeReviewQueue(packets, "test-run-001", dir);

    const jsonPath = join(dir, "_review-queue.json");
    const mdPath = join(dir, "_review-queue.md");

    // JSON exists and is valid
    const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
    expect(json.run_id).toBe("test-run-001");
    expect(json.packets).toHaveLength(1);
    expect(json.packets[0].sourcePath).toBe("docs/auth.md");

    // Markdown exists and contains key content
    const md = readFileSync(mdPath, "utf-8");
    expect(md).toContain("review-required");
    expect(md).toContain("docs/auth.md");
    expect(md).toContain("Review decision:");

    // readReviewQueue reads from JSON
    const read = readReviewQueue(dir);
    expect(read).toHaveLength(1);
    expect(read[0].sourcePath).toBe("docs/auth.md");
  });

  it("returns empty array when no queue file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-gov-"));
    expect(readReviewQueue(dir)).toEqual([]);
  });
});

describe("applyReviewDecisions", () => {
  it("merges reviewDecision into pending packets by sourcePath", () => {
    const pending: ReviewPacket[] = [
      buildReviewPacket(makeResult(), "docs/auth.md", "smartdocs/doctrine/active/auth.md", [], "reason", "defer"),
      buildReviewPacket(makeResult(), "docs/other.md", "smartdocs/raw/other.md", [], "reason", "defer"),
    ];
    const reviewed: ReviewPacket[] = [
      { ...pending[0], reviewDecision: "approve", reviewedAt: "2026-06-11T00:00:00Z" },
    ];
    const merged = applyReviewDecisions(pending, reviewed);
    expect(merged[0].reviewDecision).toBe("approve");
    expect(merged[0].reviewedAt).toBe("2026-06-11T00:00:00Z");
    expect(merged[1].reviewDecision).toBeUndefined();
  });
});
