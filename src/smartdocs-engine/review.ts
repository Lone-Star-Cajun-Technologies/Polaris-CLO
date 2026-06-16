import { execSync } from "node:child_process";
import * as readline from "node:readline";
import { resolve } from "node:path";
import type { ReviewPacket } from "../governance/types.js";
import { readReviewQueue, writeReviewQueue } from "../governance/index.js";
import { ingestDocs, printIngestResults } from "./ingest.js";

export function filterUndecided(packets: ReviewPacket[]): ReviewPacket[] {
  return packets.filter(
    (p) => p.reviewDecision === undefined || p.reviewDecision === "defer",
  );
}

export function formatPacketCard(
  packet: ReviewPacket,
  index: number,
  total: number,
): string {
  const divider = "─".repeat(65);
  return [
    divider,
    `[${index}/${total}] ${packet.sourcePath}`,
    `  → ${packet.proposedDestination}`,
    `  Authority risk:  ${packet.authorityRisk.toUpperCase()}`,
    `  Recommendation:  ${packet.recommendation}`,
    ``,
    `[a]pprove  [r]eject  [d]efer  [s]kip  [q]uit`,
    divider,
  ].join("\n");
}

export type ReadKeyFn = (packet: ReviewPacket) => Promise<string>;

export interface ReviewSessionOptions {
  repoRoot: string;
  queueDir?: string;
  queueFilename?: string;
  readKey?: ReadKeyFn;
  getReviewedBy?: () => string;
  output?: (msg: string) => void;
}

function defaultGetReviewedBy(): string {
  try {
    return execSync("git config user.name", { encoding: "utf-8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

function readSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const handler = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", handler);
      if (key?.ctrl && key.name === "c") process.exit(0);
      resolve(key?.name ?? _str ?? "");
    };

    process.stdin.on("keypress", handler);
  });
}

export async function runReviewSession(options: ReviewSessionOptions): Promise<void> {
  const {
    repoRoot,
    readKey,
    getReviewedBy = defaultGetReviewedBy,
    output = (msg: string) => process.stdout.write(msg + "\n"),
  } = options;

  const queueDir = options.queueDir ?? resolve(repoRoot, "smartdocs", "raw");
  const queueFilename = options.queueFilename;
  const packets = readReviewQueue(queueDir, queueFilename);

  if (packets.length === 0) {
    output("No review queue found. Run polaris docs ingest first.");
    return;
  }

  const undecided = filterUndecided(packets);
  if (undecided.length === 0) {
    output("Nothing to review. All decisions are final — run polaris docs ingest to apply.");
    return;
  }

  let decided = 0;

  for (let i = 0; i < undecided.length; i++) {
    const packet = undecided[i];
    output(formatPacketCard(packet, i + 1, undecided.length));

    const key = readKey ? await readKey(packet) : await readSingleKey();

    if (key === "q") {
      const remaining = undecided.length - decided;
      output(`\nSession ended. ${decided} decision(s) saved, ${remaining} packet(s) still pending.`);
      output("Run polaris docs review to continue.");
      return;
    }

    if (key === "s") {
      continue;
    }

    const decision =
      key === "a" ? "approve" :
      key === "r" ? "reject" :
      key === "d" ? "defer" :
      null;

    if (!decision) {
      output("Unrecognized key. Use [a], [r], [d], [s], or [q].");
      i--;
      continue;
    }

    const idx = packets.findIndex((p) => p.sourcePath === packet.sourcePath);
    if (idx !== -1) {
      packets[idx] = {
        ...packets[idx],
        reviewDecision: decision as import("../governance/types.js").ReviewRecommendation,
        reviewedAt: new Date().toISOString(),
        reviewedBy: getReviewedBy(),
      };
    }

    writeReviewQueue(packets, "review-session", queueDir, queueFilename);
    decided++;
  }

  const approved = packets.filter((p) => p.reviewDecision === "approve").length;
  const rejected = packets.filter((p) => p.reviewDecision === "reject").length;
  const deferred = packets.filter((p) => p.reviewDecision === "defer").length;
  output(`\nReview complete: ${approved} approved, ${rejected} rejected, ${deferred} deferred.`);

  const pendingFiles = packets
    .filter((p) => p.reviewDecision === "approve" || p.reviewDecision === "reject")
    .map((p) => p.sourcePath);

  if (pendingFiles.length > 0) {
    output("Running docs ingest to apply decisions...");
    try {
      const results = ingestDocs(pendingFiles, { repoRoot });
      printIngestResults(results);
    } catch (err) {
      output(`Ingest error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
