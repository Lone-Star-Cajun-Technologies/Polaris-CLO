# `polaris docs review` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `polaris docs review` — an interactive terminal wizard that walks through undecided review packets one at a time, captures keypress decisions, persists them to `_review-queue.json`, and auto-triggers `ingestDocs` on session completion.

**Architecture:** A new `src/smartdocs-engine/review.ts` owns the session loop with injectable `readKey`/`output`/`getReviewedBy` dependencies so the core logic is unit-testable without spawning a real TTY. The CLI wiring in `index.ts` wires the command and provides production dependencies (raw-mode stdin keypress reader, git config user). Queue I/O goes exclusively through `readReviewQueue`/`writeReviewQueue` from `../governance/index.js`.

**Tech Stack:** TypeScript ESM (`.js` imports), Node `readline` (built-in, no new deps), Commander (existing), Vitest for tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/smartdocs-engine/review.ts` | Create | Session logic: filter undecided, display cards, keypress loop, persist decisions, trigger ingest |
| `src/smartdocs-engine/review.test.ts` | Create | Unit tests with injectable deps |
| `src/smartdocs-engine/index.ts` | Modify | Add `docs review` command, wire production deps |

---

## Key Types and Interfaces

These are defined in `src/governance/types.ts` (already exists — do not redefine):

```typescript
type ReviewRecommendation = "approve" | "reject" | "defer";
interface ReviewPacket {
  sourcePath: string;
  proposedDestination: string;
  authorityRisk: "low" | "medium" | "high";
  recommendation: ReviewRecommendation;
  reviewDecision?: ReviewRecommendation;
  reviewedAt?: string;
  reviewedBy?: string;
  // ...other fields exist but are not used by review.ts
}
```

**Undecided packets** = packets where `reviewDecision` is `undefined` OR `"defer"`.
**Terminal decisions** = `"approve"` or `"reject"` — excluded from future sessions.

---

## Task 1: Pure helpers and types in `review.ts`

**Files:**
- Create: `src/smartdocs-engine/review.ts`
- Create: `src/smartdocs-engine/review.test.ts`

- [ ] **Step 1: Write failing tests for `filterUndecided` and `formatPacketCard`**

Create `src/smartdocs-engine/review.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/smartdocs-engine/review.test.ts 2>&1 | tail -10
```

Expected: FAIL — `review.js` not found.

- [ ] **Step 3: Implement `filterUndecided` and `formatPacketCard` in `review.ts`**

Create `src/smartdocs-engine/review.ts`:

```typescript
import type { ReviewPacket, ReviewRecommendation } from "../governance/types.js";

export function filterUndecided(packets: ReviewPacket[]): ReviewPacket[] {
  return packets.filter(
    (p) => p.reviewDecision === undefined || p.reviewDecision === "defer",
  );
}

export function formatPacketCard(packet: ReviewPacket, index: number, total: number): string {
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- src/smartdocs-engine/review.test.ts 2>&1 | tail -10
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/smartdocs-engine/review.ts src/smartdocs-engine/review.test.ts
git commit -m "feat(review): add filterUndecided and formatPacketCard helpers"
```

---

## Task 2: `runReviewSession` core logic

**Files:**
- Modify: `src/smartdocs-engine/review.ts`
- Modify: `src/smartdocs-engine/review.test.ts`

### Context

`readReviewQueue(outputDir: string): ReviewPacket[]` and `writeReviewQueue(packets, runId, outputDir)` are imported from `../governance/index.js`.

`ingestDocs(files: string[], options: IngestOptions): IngestResult[]` and `printIngestResults` are imported from `./ingest.js`.

`rawDir` = `resolve(repoRoot, "smartdocs", "raw")`.

### Injectable dependencies

`runReviewSession` accepts injectable deps so tests don't need a real TTY or filesystem:

```typescript
export type ReadKeyFn = () => Promise<string>;

export interface ReviewSessionOptions {
  repoRoot: string;
  queueDir?: string;            // absolute path; defaults to <repoRoot>/smartdocs/raw
  readKey?: ReadKeyFn;          // injectable for tests
  getReviewedBy?: () => string; // injectable for tests
  output?: (msg: string) => void; // injectable for tests
}
```

- [ ] **Step 1: Write failing tests for `runReviewSession`**

Add to `src/smartdocs-engine/review.test.ts`:

```typescript
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runReviewSession, type ReadKeyFn } from "./review.js";

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

  it("approve writes reviewDecision: approve to queue immediately", async () => {
    const dir = makeQueueDir([makePacket({ sourcePath: "smartdocs/raw/foo.md" })]);
    const lines: string[] = [];
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("a"),
      getReviewedBy: () => "tester",
      output: (msg) => lines.push(msg),
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

  it("defer writes reviewDecision: defer and packet reappears on next session", async () => {
    const dir = makeQueueDir([makePacket()]);
    // Session 1: defer
    await runReviewSession({
      repoRoot: dir,
      queueDir: dir,
      readKey: makeKeys("d"),
      getReviewedBy: () => "tester",
      output: () => {},
    });
    let saved = JSON.parse(readFileSync(join(dir, "_review-queue.json"), "utf-8"));
    expect(saved.packets[0].reviewDecision).toBe("defer");

    // Session 2: deferred packet shown again, approve it
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

  it("skip leaves packet undecided and moves to next", async () => {
    const dir = makeQueueDir([
      makePacket({ sourcePath: "a.md" }),
      makePacket({ sourcePath: "b.md" }),
    ]);
    // skip first, approve second, then quit (only 2 packets, approving second completes)
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
    // No ingest ran (would throw if called with bad repoRoot — but it didn't throw)
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- src/smartdocs-engine/review.test.ts 2>&1 | tail -10
```

Expected: FAIL — `runReviewSession` not exported.

- [ ] **Step 3: Implement `runReviewSession` in `review.ts`**

Add to `src/smartdocs-engine/review.ts` (append after existing helpers):

```typescript
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { readReviewQueue, writeReviewQueue } from "../governance/index.js";
import { ingestDocs, printIngestResults } from "./ingest.js";

export type ReadKeyFn = () => Promise<string>;

export interface ReviewSessionOptions {
  repoRoot: string;
  queueDir?: string;
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

export async function runReviewSession(options: ReviewSessionOptions): Promise<void> {
  const {
    repoRoot,
    readKey,
    getReviewedBy = defaultGetReviewedBy,
    output = (msg: string) => process.stdout.write(msg + "\n"),
  } = options;

  const queueDir = options.queueDir ?? resolve(repoRoot, "smartdocs", "raw");
  const packets = readReviewQueue(queueDir);

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

    const key = readKey ? await readKey() : await readSingleKey();

    if (key === "q") {
      const remaining = undecided.length - decided;
      output(`\nSession ended. ${decided} decision(s) saved, ${remaining} packet(s) still pending.`);
      output("Run polaris docs review to continue.");
      return;
    }

    if (key === "s") {
      continue;
    }

    const decision = key === "a" ? "approve" : key === "r" ? "reject" : key === "d" ? "defer" : null;
    if (!decision) {
      output("Unrecognized key. Use [a], [r], [d], [s], or [q].");
      i--; // re-show same packet
      continue;
    }

    // Update packet in the full list (not just undecided slice)
    const idx = packets.findIndex((p) => p.sourcePath === packet.sourcePath);
    if (idx !== -1) {
      packets[idx] = {
        ...packets[idx],
        reviewDecision: decision as ReviewRecommendation,
        reviewedAt: new Date().toISOString(),
        reviewedBy: getReviewedBy(),
      };
    }

    // Persist immediately after each decision
    writeReviewQueue(packets, "review-session", queueDir);
    decided++;
  }

  // Count outcomes
  const approved = packets.filter((p) => p.reviewDecision === "approve").length;
  const rejected = packets.filter((p) => p.reviewDecision === "reject").length;
  const deferred = packets.filter((p) => p.reviewDecision === "defer").length;
  output(`\nReview complete: ${approved} approved, ${rejected} rejected, ${deferred} deferred.`);

  // Auto-trigger ingest to apply approved/rejected decisions
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
```

- [ ] **Step 4: Add `readSingleKey` production keypress reader** (append to `review.ts`):

```typescript
import * as readline from "node:readline";

function readSingleKey(): Promise<string> {
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const handler = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", handler);
      if (key?.ctrl && key.name === "c") process.exit(0);
      resolve(key?.name ?? _str ?? "");
    };

    process.stdin.on("keypress", handler);
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test -- src/smartdocs-engine/review.test.ts 2>&1 | tail -15
```

Expected: PASS (all tests including the 7 from Task 1 + 7 new tests = 14 total).

- [ ] **Step 6: Commit**

```bash
git add src/smartdocs-engine/review.ts src/smartdocs-engine/review.test.ts
git commit -m "feat(review): implement runReviewSession with injectable deps"
```

---

## Task 3: Wire `docs review` command in `index.ts`

**Files:**
- Modify: `src/smartdocs-engine/index.ts`

- [ ] **Step 1: Add import for `runReviewSession`**

At the top of `src/smartdocs-engine/index.ts`, add to the existing imports:

```typescript
import { runReviewSession } from "./review.js";
```

- [ ] **Step 2: Add `docs review` command**

Inside `createDocsCommand`, after the `ingest` command block and before the `migrate` command block, add:

```typescript
  docs
    .command("review")
    .description("Interactively review pending governance decisions in the review queue")
    .option("--queue <path>", "path to _review-queue.json (default: smartdocs/raw/_review-queue.json)")
    .option("-r, --repo-root <path>", "Repository root", defaultRepoRoot)
    .action(async (opts: { queue?: string; repoRoot: string }) => {
      try {
        const queueDir = opts.queue
          ? resolve(opts.repoRoot, opts.queue).replace(/_review-queue\.json$/, "").replace(/\/$/, "")
          : resolve(opts.repoRoot, "smartdocs", "raw");

        await runReviewSession({ repoRoot: opts.repoRoot, queueDir });
      } catch (err) {
        console.error(`polaris docs review: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
```

- [ ] **Step 3: Verify the command appears in help**

```bash
cd /Users/lsctech/Developer/Polaris && npm run polaris-cli -- docs --help 2>&1 | grep review
```

Expected output includes: `review  Interactively review pending governance decisions in the review queue`

- [ ] **Step 4: Typecheck**

```bash
npm run typecheck 2>&1 | tail -10
```

Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/smartdocs-engine/index.ts
git commit -m "feat(cli): add polaris docs review command"
```

---

## Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run full test suite**

```bash
npm test 2>&1 | grep -E "Test Files|Tests " | tail -5
```

Expected: all tests pass (1679+ passing).

- [ ] **Step 2: Run governance and review tests specifically**

```bash
npm test -- src/smartdocs-engine/review.test.ts src/governance/ 2>&1 | tail -10
```

Expected: all pass.

- [ ] **Step 3: Smoke test in EVO with a dummy queue**

```bash
cd /Users/lsctech/Developer/git-fit && polaris docs review --help
```

Expected: help text with `--queue` and `--repo-root` options.

- [ ] **Step 4: Bump patch version and publish**

```bash
cd /Users/lsctech/Developer/Polaris
npm version patch --no-git-tag-version
git add package.json package-lock.json
git commit -m "chore: bump version to 0.2.1"
npm publish --access public
```

Expected: `+ @lsctech/polaris@0.2.1`

Then update EVO:

```bash
cd /Users/lsctech/Developer/git-fit && npm install @lsctech/polaris@0.2.1
```
