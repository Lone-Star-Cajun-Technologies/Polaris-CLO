import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filterUndecided, formatPacketCard, runReviewSession, type ReadKeyFn } from "./review.js";
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

function makeQueueDir(packets: ReviewPacket[]): string {
  const dir = mkdtempSync(join(tmpdir(), "polaris-review-test-"));
  const queue = {
    generated_at: new Date().toISOString(),
    run_id: "test-run",
    packets,
  };
  writeFileSync(join(dir, "_review-queue.json"), JSON.stringify(queue, null, 2), "utf-8");
  return dir;
}

function makeKeys(...keys: string[]): ReadKeyFn {
  const queue = [...keys];
  return async () => queue.shift() ?? "q";
}

describe("runReviewSession", () => {
  it("prints no-queue message when queue file missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-review-empty-"));
    const lines: string[] = [];
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      output: (msg) => lines.push(msg),
    });
    expect(lines.join("\n")).toContain("No review queue found");
  });

  it("prints all-decided message when no undecided packets remain", async () => {
    const dir = makeQueueDir([makePacket({ reviewDecision: "approve" })]);
    const lines: string[] = [];
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      output: (msg) => lines.push(msg),
    });
    expect(lines.join("\n")).toContain("Nothing to review");
  });

  it("approve writes reviewDecision: approve immediately", async () => {
    const dir = makeQueueDir([makePacket({ sourcePath: "smartdocs/raw/foo.md" })]);
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("a"),
      getReviewedBy: () => "tester",
      output: () => {},
    });
    const saved = JSON.parse(readFileSync(join(dir, "_review-queue.json"), "utf-8"));
    expect(saved.packets[0].reviewDecision).toBe("approve");
    expect(saved.packets[0].reviewedBy).toBe("tester");
    expect(saved.packets[0].reviewedAt).toBeDefined();
  });

  it("reject writes reviewDecision: reject", async () => {
    const dir = makeQueueDir([makePacket()]);
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("r"),
      getReviewedBy: () => "tester",
      output: () => {},
    });
    const saved = JSON.parse(readFileSync(join(dir, "_review-queue.json"), "utf-8"));
    expect(saved.packets[0].reviewDecision).toBe("reject");
  });

  it("defer writes reviewDecision: defer and packet reappears next session", async () => {
    const dir = makeQueueDir([makePacket()]);
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("d"),
      getReviewedBy: () => "tester",
      output: () => {},
    });
    let saved = JSON.parse(readFileSync(join(dir, "_review-queue.json"), "utf-8"));
    expect(saved.packets[0].reviewDecision).toBe("defer");

    // Second session: deferred packet shown again
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("a"),
      getReviewedBy: () => "tester",
      output: () => {},
    });
    saved = JSON.parse(readFileSync(join(dir, "_review-queue.json"), "utf-8"));
    expect(saved.packets[0].reviewDecision).toBe("approve");
  });

  it("skip leaves packet undecided", async () => {
    const dir = makeQueueDir([
      makePacket({ sourcePath: "a.md" }),
      makePacket({ sourcePath: "b.md" }),
    ]);
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("s", "a"),
      getReviewedBy: () => "tester",
      output: () => {},
    });
    const saved = JSON.parse(readFileSync(join(dir, "_review-queue.json"), "utf-8"));
    const a = saved.packets.find((p: ReviewPacket) => p.sourcePath === "a.md");
    const b = saved.packets.find((p: ReviewPacket) => p.sourcePath === "b.md");
    expect(a.reviewDecision).toBeUndefined();
    expect(b.reviewDecision).toBe("approve");
  });

  it("quit exits without triggering ingest, prints pending count", async () => {
    const dir = makeQueueDir([makePacket(), makePacket({ sourcePath: "b.md" })]);
    const lines: string[] = [];
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("q"),
      output: (msg) => lines.push(msg),
    });
    expect(lines.join("\n")).toContain("pending");
  });
});
