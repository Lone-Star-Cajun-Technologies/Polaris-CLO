import { describe, expect, it } from "vitest";
import { filterUndecided, formatPacketCard } from "./review.js";
import type { ReviewPacket } from "../governance/types.js";

function makePacket(overrides: Partial<ReviewPacket> = {}): ReviewPacket {
  return {
    sourcePath: "smartdocs/raw/test.md",
    proposedDestination: "smartdocs/doctrine/candidate/test.md",
    classificationConfidence: 0.4,
    destinationCertainty: 0.3,
    authorityRisk: "medium",
    reasoning: ["test reason"],
    conflicts: [],
    recommendation: "defer",
    outcomeReason: "confidence below threshold",
    ...overrides,
  };
}

describe("filterUndecided", () => {
  it("includes packets with no reviewDecision", () => {
    const packets = [makePacket()];
    expect(filterUndecided(packets)).toHaveLength(1);
  });

  it("includes packets with reviewDecision: defer", () => {
    const packets = [makePacket({ reviewDecision: "defer" })];
    expect(filterUndecided(packets)).toHaveLength(1);
  });

  it("excludes packets with reviewDecision: approve", () => {
    const packets = [makePacket({ reviewDecision: "approve" })];
    expect(filterUndecided(packets)).toHaveLength(0);
  });

  it("excludes packets with reviewDecision: reject", () => {
    const packets = [makePacket({ reviewDecision: "reject" })];
    expect(filterUndecided(packets)).toHaveLength(0);
  });

  it("returns only undecided from a mixed list", () => {
    const packets = [
      makePacket({ sourcePath: "a.md" }),
      makePacket({ sourcePath: "b.md", reviewDecision: "approve" }),
      makePacket({ sourcePath: "c.md", reviewDecision: "defer" }),
      makePacket({ sourcePath: "d.md", reviewDecision: "reject" }),
    ];
    const result = filterUndecided(packets);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.sourcePath)).toEqual(["a.md", "c.md"]);
  });
});

describe("formatPacketCard", () => {
  it("includes source path, proposed destination, authority risk, recommendation", () => {
    const packet = makePacket();
    const card = formatPacketCard(packet, 3, 12);
    expect(card).toContain("[3/12]");
    expect(card).toContain("smartdocs/raw/test.md");
    expect(card).toContain("smartdocs/doctrine/candidate/test.md");
    expect(card).toContain("MEDIUM");
    expect(card).toContain("defer");
  });

  it("includes keypress hint line", () => {
    const card = formatPacketCard(makePacket(), 1, 1);
    expect(card).toContain("[a]pprove");
    expect(card).toContain("[r]eject");
    expect(card).toContain("[d]efer");
    expect(card).toContain("[s]kip");
    expect(card).toContain("[q]uit");
  });
});
