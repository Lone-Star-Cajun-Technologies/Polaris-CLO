# `polaris docs triage` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `polaris docs triage` — a checkpoint-resumable command that groups 590 candidate docs into topic clusters, compares each cluster against 415 canonicals via LLM batch calls, checks all candidates against the Polaris symbol graph for stale code references, and writes `_triage-queue.json` + `_triage-report.md` for human review via `polaris docs review`.

**Architecture:** Checkpoint-resumable pipeline in `src/smartdocs-engine/triage.ts`. Phase 1 clusters candidates by YAML/filename metadata (no LLM), then sends each cluster to a configured Haiku-class model in batches of N. Phase 2 extracts code symbol references from each candidate and looks them up in the Polaris graph. All flags are written as `TriageReviewPacket` entries (extends `ReviewPacket`) so `polaris docs review` works on triage decisions unchanged.

**Tech Stack:** TypeScript, Vitest, Commander.js (existing CLI framework), `@anthropic-ai/sdk` (dynamic import, already in Polaris), Polaris graph query API (`lookupSymbol`, `getGraphStats` from `src/graph/query/index.ts`), Node built-ins (fs, path, os)

---

## Context for workers

**Key existing files to read before starting:**
- `src/governance/types.ts` — `ReviewPacket` interface you will extend
- `src/governance/review-packet.ts` — `writeReviewQueue`, `readReviewQueue` (pattern to mirror for triage queue I/O)
- `src/smartdocs-engine/review.ts` — nearest sibling, shows session/queue pattern
- `src/smartdocs-engine/index.ts` — where you will wire the `triage` CLI command (follow the `review` command pattern)
- `src/graph/query/index.ts` — `lookupSymbol(name): GraphSymbol | null` and `getGraphStats(): GraphStats`
- `src/cli/adopt-genesis.ts` lines 70–130 — shows how Polaris dynamically imports and calls `@anthropic-ai/sdk`

**Test pattern:** All tests in this repo use Vitest. See `src/smartdocs-engine/ingest.test.ts` for the `makeRepo()` temp-dir helper pattern. Tests must never hit real LLM APIs or the real graph — mock both.

**EVO repo structure (for manual testing):**
- Canonicals: `~/Developer/git-fit/smartdocs/doctrine/active/` (415 files)
- Candidates: `~/Developer/git-fit/smartdocs/doctrine/candidate/` (590 files)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/governance/types.ts` | Modify | Add `TriageReviewPacket` interface extending `ReviewPacket` |
| `src/smartdocs-engine/triage.ts` | Create | All triage logic: cluster, LLM batch, graph check, checkpoint, queue I/O, orchestrator |
| `src/smartdocs-engine/triage.test.ts` | Create | Unit tests — mock LLM and graph |
| `src/smartdocs-engine/index.ts` | Modify | Add `docs triage` CLI command |

---

## Task 1: Add `TriageReviewPacket` to governance types

**Files:**
- Modify: `src/governance/types.ts`

- [ ] **Step 1: Add the interface after `ReviewPacket`**

Open `src/governance/types.ts`. After the closing `}` of the `ReviewPacket` interface, add:

```typescript
export interface TriageReviewPacket extends ReviewPacket {
  triageFlag: "contradiction" | "duplicate" | "stale-reference";
  /** Path to the canonical doc involved (for contradiction/duplicate flags). */
  relatedCanonical?: string;
  /** Symbol names not found in the graph (for stale-reference flags). */
  staleSymbols?: string[];
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd ~/Developer/Polaris && npm run build
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd ~/Developer/Polaris && git add src/governance/types.ts && git commit -m "feat(governance): add TriageReviewPacket extending ReviewPacket"
```

---

## Task 2: Pure helpers — clustering and symbol extraction

**Files:**
- Create: `src/smartdocs-engine/triage.ts` (initial slice — pure functions only, no I/O)
- Create: `src/smartdocs-engine/triage.test.ts`

These two functions are pure (no file I/O, no LLM, no graph) — test them first.

### `clusterCandidates`

Groups candidate doc paths into named clusters based on YAML frontmatter signals and filename prefix. Each candidate is matched to the best-fitting cluster from the canonicals. Unmatched candidates go into a `"general"` bucket.

### `extractSymbols`

Scans a markdown document body for likely code symbol references: backtick tokens and CamelCase identifiers.

- [ ] **Step 1: Write failing tests for `clusterCandidates`**

Create `src/smartdocs-engine/triage.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { clusterCandidates, extractSymbols } from "./triage.js";

describe("clusterCandidates", () => {
  it("groups candidates by shared tag with canonicals", () => {
    const candidates = [
      {
        path: "smartdocs/doctrine/candidate/ADR-101.md",
        tags: ["governance"],
        type: "Decision",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: ["ADR"],
      },
      {
        path: "smartdocs/doctrine/candidate/random-note.md",
        tags: [],
        type: "Note",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: [],
      },
    ];

    const canonicals = [
      {
        path: "smartdocs/doctrine/active/ADR-001.md",
        tags: ["governance"],
        type: "Decision",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: ["ADR"],
      },
    ];

    const result = clusterCandidates(candidates, canonicals);

    // ADR-101 matches the "governance" / "ADR" cluster
    expect(result["governance"]).toBeDefined();
    expect(result["governance"].candidates).toHaveLength(1);
    expect(result["governance"].candidates[0].path).toBe("smartdocs/doctrine/candidate/ADR-101.md");
    expect(result["governance"].canonicals).toHaveLength(1);

    // random-note goes to general
    expect(result["general"]).toBeDefined();
    expect(result["general"].candidates[0].path).toBe("smartdocs/doctrine/candidate/random-note.md");
  });

  it("puts all candidates in general when no canonicals match", () => {
    const candidates = [
      {
        path: "smartdocs/doctrine/candidate/orphan.md",
        tags: ["unknown"],
        type: "Note",
        clusterMembership: [],
        relatedNotes: [],
        filenamePrefixes: [],
      },
    ];

    const result = clusterCandidates(candidates, []);
    expect(result["general"].candidates).toHaveLength(1);
  });
});

describe("extractSymbols", () => {
  it("extracts backtick tokens", () => {
    const syms = extractSymbols("Call `runTriage` then `writeCheckpoint` to proceed.");
    expect(syms).toContain("runTriage");
    expect(syms).toContain("writeCheckpoint");
  });

  it("extracts PascalCase and camelCase identifiers", () => {
    const syms = extractSymbols("The TriageRunner calls clusterCandidates before batching.");
    expect(syms).toContain("TriageRunner");
    expect(syms).toContain("clusterCandidates");
  });

  it("skips short words and plain prose", () => {
    const syms = extractSymbols("The doc is good. This runs fast.");
    expect(syms).not.toContain("The");
    expect(syms).not.toContain("This");
    expect(syms).not.toContain("good");
  });

  it("deduplicates symbols", () => {
    const syms = extractSymbols("`runTriage` and `runTriage` again.");
    expect(syms.filter((s) => s === "runTriage")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -10
```

Expected: errors — `triage.ts` does not exist yet.

- [ ] **Step 3: Create `src/smartdocs-engine/triage.ts` with the pure helpers**

```typescript
import { readFileSync } from "node:fs";
import type { TriageReviewPacket } from "../governance/types.js";

// ---------------------------------------------------------------------------
// Shared document metadata shape used internally by triage
// ---------------------------------------------------------------------------

export interface DocMeta {
  path: string;
  tags: string[];
  type: string;
  clusterMembership: string[];
  relatedNotes: string[];
  filenamePrefixes: string[];
}

export interface Cluster {
  candidates: DocMeta[];
  canonicals: DocMeta[];
}

export type ClusterMap = Record<string, Cluster>;

// ---------------------------------------------------------------------------
// clusterCandidates
// ---------------------------------------------------------------------------

/**
 * Groups candidate docs into named clusters using metadata overlap with canonicals.
 * Candidates with no signal match go into the "general" bucket.
 */
export function clusterCandidates(candidates: DocMeta[], canonicals: DocMeta[]): ClusterMap {
  const clusters: ClusterMap = {};

  // Build cluster names from canonicals
  for (const canonical of canonicals) {
    const names = clusterNamesFor(canonical);
    for (const name of names) {
      if (!clusters[name]) {
        clusters[name] = { candidates: [], canonicals: [] };
      }
      if (!clusters[name].canonicals.includes(canonical)) {
        clusters[name].canonicals.push(canonical);
      }
    }
  }

  // Assign each candidate to its best cluster
  for (const candidate of candidates) {
    const candidateNames = clusterNamesFor(candidate);
    let assigned = false;

    for (const name of candidateNames) {
      if (clusters[name]) {
        clusters[name].candidates.push(candidate);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      if (!clusters["general"]) {
        clusters["general"] = { candidates: [], canonicals: [] };
      }
      clusters["general"].candidates.push(candidate);
    }
  }

  // Ensure general bucket exists
  if (!clusters["general"]) {
    clusters["general"] = { candidates: [], canonicals: [] };
  }

  return clusters;
}

function clusterNamesFor(doc: DocMeta): string[] {
  const names: string[] = [];

  // Tags take priority
  for (const tag of doc.tags) {
    if (tag.trim()) names.push(tag.toLowerCase().trim());
  }

  // Cluster membership
  for (const c of doc.clusterMembership) {
    if (c.trim()) names.push(c.toLowerCase().trim());
  }

  // Filename prefix (e.g. "ADR", "EVOlearn")
  for (const p of doc.filenamePrefixes) {
    if (p.trim()) names.push(p.toLowerCase().trim());
  }

  // Type as fallback
  if (doc.type.trim()) names.push(doc.type.toLowerCase().trim());

  return names;
}

// ---------------------------------------------------------------------------
// extractSymbols
// ---------------------------------------------------------------------------

const BACKTICK_RE = /`([A-Za-z_][A-Za-z0-9_]{3,})`/g;
const CAMEL_PASCAL_RE = /(?<![`\w])([A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z][a-z]+(?:[A-Z][a-z0-9]+)+)(?![`\w])/g;

/**
 * Extracts likely code symbol names from markdown text.
 * Returns deduplicated symbol names of 4+ characters.
 */
export function extractSymbols(text: string): string[] {
  const found = new Set<string>();

  let m: RegExpExecArray | null;

  BACKTICK_RE.lastIndex = 0;
  while ((m = BACKTICK_RE.exec(text)) !== null) {
    found.add(m[1]);
  }

  CAMEL_PASCAL_RE.lastIndex = 0;
  while ((m = CAMEL_PASCAL_RE.exec(text)) !== null) {
    found.add(m[1]);
  }

  return Array.from(found);
}

// ---------------------------------------------------------------------------
// Placeholder exports referenced in later tasks (stubs — filled in Task 3+)
// ---------------------------------------------------------------------------

export interface TriageOptions {
  repoRoot: string;
  batchSize?: number;
  resume?: boolean;
  dryRun?: boolean;
  output?: (msg: string) => void;
  // Injected in tests; production code uses dynamic require
  llmClient?: LlmClient;
  // Injected in tests; production code uses graph query module
  symbolLookup?: (name: string) => boolean;
  graphStats?: () => { symbolCount: number };
}

export interface TriageResult {
  flagCount: number;
  outputDir: string;
}

export interface LlmClient {
  compare(
    candidates: DocMeta[],
    canonicals: DocMeta[],
    model: string,
  ): Promise<TriageLlmFlag[]>;
}

export interface TriageLlmFlag {
  candidatePath: string;
  flagType: "contradiction" | "duplicate";
  canonicalPath?: string;
  reason: string;
}

// Stubs — implemented in later tasks
export async function runTriage(_options: TriageOptions): Promise<TriageResult> {
  throw new Error("not implemented");
}
```

- [ ] **Step 4: Run tests — expect them to pass**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/triage.ts src/smartdocs-engine/triage.test.ts && git commit -m "feat(triage): add clusterCandidates and extractSymbols pure helpers"
```

---

## Task 3: YAML metadata reader and `DocMeta` loader

**Files:**
- Modify: `src/smartdocs-engine/triage.ts` — add `loadDocMeta` and `loadAllDocMeta`
- Modify: `src/smartdocs-engine/triage.test.ts` — add tests

These functions read `.md` files from disk, parse YAML frontmatter, and return `DocMeta` objects. They are the only file-I/O functions that feed clustering.

- [ ] **Step 1: Add tests for `loadDocMeta`**

Add to `src/smartdocs-engine/triage.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadDocMeta } from "./triage.js";

describe("loadDocMeta", () => {
  it("parses tags, type, and cluster from YAML frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
    const docPath = join(dir, "test.md");
    writeFileSync(docPath, [
      "---",
      "Tags: [governance, learning]",
      "Type: Decision",
      "Member Of Concept Cluster: [EVOlearn]",
      "Related Notes:",
      '  - "[[ADR-002|ADR-002]]"',
      "---",
      "# Body text",
    ].join("\n"), "utf-8");

    const meta = loadDocMeta(docPath);
    expect(meta.tags).toContain("governance");
    expect(meta.tags).toContain("learning");
    expect(meta.type).toBe("Decision");
    expect(meta.clusterMembership).toContain("EVOlearn");
    expect(meta.filenamePrefixes).toContain("test");
  });

  it("returns empty arrays for docs with no frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-test-"));
    const docPath = join(dir, "plain.md");
    writeFileSync(docPath, "# Just a heading\n\nSome text.", "utf-8");

    const meta = loadDocMeta(docPath);
    expect(meta.tags).toEqual([]);
    expect(meta.type).toBe("");
    expect(meta.clusterMembership).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -10
```

Expected: FAIL — `loadDocMeta` not exported.

- [ ] **Step 3: Implement `loadDocMeta` and `loadAllDocMeta` in `triage.ts`**

Add after the `extractSymbols` function:

```typescript
import { readdirSync } from "node:fs";
import { basename, extname } from "node:path";

/**
 * Parses YAML frontmatter from a markdown file and returns DocMeta.
 * Does not throw — returns empty arrays on any parse failure.
 */
export function loadDocMeta(filePath: string): DocMeta {
  let content = "";
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return emptyMeta(filePath);
  }

  const frontmatter = parseFrontmatter(content);
  const filenamePrefixes = extractFilenamePrefixes(basename(filePath, extname(filePath)));

  return {
    path: filePath,
    tags: toStringArray(frontmatter["Tags"] ?? frontmatter["tags"]),
    type: String(frontmatter["Type"] ?? frontmatter["type"] ?? "").trim(),
    clusterMembership: toStringArray(frontmatter["Member Of Concept Cluster"]),
    relatedNotes: toStringArray(frontmatter["Related Notes"]),
    filenamePrefixes,
  };
}

/**
 * Reads all .md files from a directory and returns their DocMeta.
 */
export function loadAllDocMeta(dir: string): DocMeta[] {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  return entries.map((f) => loadDocMeta(join(dir, f)));
}

function emptyMeta(filePath: string): DocMeta {
  return {
    path: filePath,
    tags: [],
    type: "",
    clusterMembership: [],
    relatedNotes: [],
    filenamePrefixes: extractFilenamePrefixes(basename(filePath, extname(filePath))),
  };
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  const listBuffer: string[] = [];

  const flushList = () => {
    if (currentKey && listBuffer.length > 0) {
      result[currentKey] = [...listBuffer];
      listBuffer.length = 0;
    }
  };

  for (const line of lines) {
    // Inline array: Tags: [a, b]
    const inlineMatch = line.match(/^([^:]+):\s*\[(.*)\]$/);
    if (inlineMatch) {
      flushList();
      currentKey = null;
      const key = inlineMatch[1].trim();
      result[key] = inlineMatch[2]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }

    // Key with value: Type: Decision
    const kvMatch = line.match(/^([^:]+):\s*(.+)$/);
    if (kvMatch && !line.startsWith("  ")) {
      flushList();
      currentKey = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      if (val !== "") {
        result[currentKey] = val.replace(/^["']|["']$/g, "");
        currentKey = null;
      }
      continue;
    }

    // Key with no inline value (list follows)
    const keyOnlyMatch = line.match(/^([^:]+):\s*$/);
    if (keyOnlyMatch && !line.startsWith("  ")) {
      flushList();
      currentKey = keyOnlyMatch[1].trim();
      continue;
    }

    // List item under current key
    const listItemMatch = line.match(/^\s+-\s+"?\[\[([^\]|]+)(?:\|[^\]]+)?\]\]"?$/);
    if (listItemMatch && currentKey) {
      listBuffer.push(listItemMatch[1].trim());
      continue;
    }

    const simpleItemMatch = line.match(/^\s+-\s+(.+)$/);
    if (simpleItemMatch && currentKey) {
      listBuffer.push(simpleItemMatch[1].trim().replace(/^["']|["']$/g, ""));
    }
  }

  flushList();
  return result;
}

function toStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function extractFilenamePrefixes(stem: string): string[] {
  // "ADR-001 - Some Title" → ["ADR"]
  // "EVOlearn_Governance" → ["EVOlearn"]
  const parts = stem.split(/[-_ ]/);
  return parts.slice(0, 2).filter((p) => p.length >= 3);
}
```

- [ ] **Step 4: Fix imports at the top of `triage.ts`**

Replace the existing import line at the top of `src/smartdocs-engine/triage.ts` with:

```typescript
import { readFileSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { TriageReviewPacket } from "../governance/types.js";
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 6: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/triage.ts src/smartdocs-engine/triage.test.ts && git commit -m "feat(triage): add loadDocMeta, loadAllDocMeta, and YAML frontmatter parser"
```

---

## Task 4: Checkpoint I/O and triage queue writer

**Files:**
- Modify: `src/smartdocs-engine/triage.ts` — add checkpoint and queue I/O
- Modify: `src/smartdocs-engine/triage.test.ts` — add tests

- [ ] **Step 1: Add tests for checkpoint and queue I/O**

Add to `src/smartdocs-engine/triage.test.ts`:

```typescript
import {
  readTriageCheckpoint,
  writeTriageCheckpoint,
  writeTriageQueue,
} from "./triage.js";
import { existsSync, readFileSync } from "node:fs";

describe("checkpoint I/O", () => {
  it("returns null when no checkpoint exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-ckpt-"));
    expect(readTriageCheckpoint(dir)).toBeNull();
  });

  it("round-trips a checkpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-ckpt-"));
    const ckpt = { completedClusters: ["governance", "decision"], flags: [] };
    writeTriageCheckpoint(ckpt, dir);
    const loaded = readTriageCheckpoint(dir);
    expect(loaded?.completedClusters).toEqual(["governance", "decision"]);
  });
});

describe("writeTriageQueue", () => {
  it("writes _triage-queue.json and _triage-report.md", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-queue-"));
    const packet: import("../governance/types.js").TriageReviewPacket = {
      sourcePath: "smartdocs/doctrine/candidate/foo.md",
      proposedDestination: "smartdocs/doctrine/candidate/foo.md",
      classificationConfidence: 0,
      destinationCertainty: 0,
      authorityRisk: "low",
      reasoning: [],
      conflicts: [],
      recommendation: "defer",
      outcomeReason: "flagged by triage",
      triageFlag: "contradiction",
      relatedCanonical: "smartdocs/doctrine/active/bar.md",
    };

    writeTriageQueue([packet], dir);

    expect(existsSync(join(dir, "_triage-queue.json"))).toBe(true);
    expect(existsSync(join(dir, "_triage-report.md"))).toBe(true);

    const raw = JSON.parse(readFileSync(join(dir, "_triage-queue.json"), "utf-8"));
    expect(raw.packets).toHaveLength(1);
    expect(raw.packets[0].triageFlag).toBe("contradiction");
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -10
```

Expected: FAIL — functions not implemented yet.

- [ ] **Step 3: Add checkpoint and queue I/O to `triage.ts`**

Add after the `extractFilenamePrefixes` function:

```typescript
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export interface TriageCheckpoint {
  completedClusters: string[];
  flags: TriageLlmFlag[];
}

const CHECKPOINT_FILENAME = "_triage-checkpoint.json";

export function readTriageCheckpoint(outputDir: string): TriageCheckpoint | null {
  const p = join(outputDir, CHECKPOINT_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as TriageCheckpoint;
  } catch {
    return null;
  }
}

export function writeTriageCheckpoint(checkpoint: TriageCheckpoint, outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, CHECKPOINT_FILENAME), JSON.stringify(checkpoint, null, 2), "utf-8");
}

export function deleteTriageCheckpoint(outputDir: string): void {
  const p = join(outputDir, CHECKPOINT_FILENAME);
  if (existsSync(p)) {
    import("node:fs").then((fs) => fs.unlinkSync(p)).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Triage queue writer
// ---------------------------------------------------------------------------

export function writeTriageQueue(packets: TriageReviewPacket[], outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  const queueFile = {
    generated_at: new Date().toISOString(),
    run_id: `triage-${Date.now()}`,
    packets,
  };

  writeFileSync(
    join(outputDir, "_triage-queue.json"),
    JSON.stringify(queueFile, null, 2),
    "utf-8",
  );

  writeFileSync(
    join(outputDir, "_triage-report.md"),
    renderTriageReport(packets),
    "utf-8",
  );
}

function renderTriageReport(packets: TriageReviewPacket[]): string {
  const contradictions = packets.filter((p) => p.triageFlag === "contradiction");
  const duplicates = packets.filter((p) => p.triageFlag === "duplicate");
  const stale = packets.filter((p) => p.triageFlag === "stale-reference");

  const lines: string[] = [
    "# Polaris Docs Triage Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "",
    `| Flag | Count |`,
    `|------|-------|`,
    `| contradiction | ${contradictions.length} |`,
    `| duplicate | ${duplicates.length} |`,
    `| stale-reference | ${stale.length} |`,
    `| **total** | **${packets.length}** |`,
    "",
    "## Flagged Documents",
    "",
    "This file is display-only. Edit `_triage-queue.json` to record decisions,",
    "or run `polaris docs review` to walk through them interactively.",
    "",
  ];

  for (const p of packets) {
    lines.push(`### ${p.triageFlag.toUpperCase()} · ${p.sourcePath}`);
    lines.push("");
    lines.push(`**Reason:** ${p.outcomeReason}`);
    if (p.relatedCanonical) {
      lines.push(`**Conflicts with:** ${p.relatedCanonical}`);
    }
    if (p.staleSymbols && p.staleSymbols.length > 0) {
      lines.push(`**Stale symbols:** ${p.staleSymbols.join(", ")}`);
    }
    lines.push(`**Review decision:** ${p.reviewDecision ?? "← pending"}`);
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Fix import block at the top of `triage.ts`**

Replace the import block at the top of `src/smartdocs-engine/triage.ts` with:

```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { TriageReviewPacket } from "../governance/types.js";
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 6: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/triage.ts src/smartdocs-engine/triage.test.ts && git commit -m "feat(triage): add checkpoint I/O and triage queue writer"
```

---

## Task 5: LLM batch comparison (Phase 1 core)

**Files:**
- Modify: `src/smartdocs-engine/triage.ts` — implement `runBatchComparison`
- Modify: `src/smartdocs-engine/triage.test.ts` — add tests

`runBatchComparison` sends one cluster's candidates + canonical summaries to the LLM and returns parsed flags. It accepts an injectable `llmClient` so tests never call the real API.

Model resolution order: `POLARIS_TRIAGE_MODEL` env var → `options.triageModel` (from config) → `"claude-haiku-4-5-20251001"` hardcoded fallback. This lets the model name change without code changes.

- [ ] **Step 1: Add tests for `runBatchComparison`**

Add to `src/smartdocs-engine/triage.test.ts`:

```typescript
import { runBatchComparison } from "./triage.js";
import type { LlmClient, DocMeta, TriageLlmFlag } from "./triage.js";

describe("runBatchComparison", () => {
  const candidates: DocMeta[] = [
    {
      path: "smartdocs/doctrine/candidate/ADR-101.md",
      tags: ["governance"],
      type: "Decision",
      clusterMembership: [],
      relatedNotes: [],
      filenamePrefixes: ["ADR"],
    },
  ];

  const canonicals: DocMeta[] = [
    {
      path: "smartdocs/doctrine/active/ADR-001.md",
      tags: ["governance"],
      type: "Decision",
      clusterMembership: [],
      relatedNotes: [],
      filenamePrefixes: ["ADR"],
    },
  ];

  it("returns flags from a valid LLM response", async () => {
    const mockClient: LlmClient = {
      async compare(_c, _can, _model) {
        return [
          {
            candidatePath: "smartdocs/doctrine/candidate/ADR-101.md",
            flagType: "contradiction",
            canonicalPath: "smartdocs/doctrine/active/ADR-001.md",
            reason: "Claims opposite authority model.",
          },
        ];
      },
    };

    const flags = await runBatchComparison(candidates, canonicals, {
      model: "claude-haiku-4-5-20251001",
      llmClient: mockClient,
    });

    expect(flags).toHaveLength(1);
    expect(flags[0].flagType).toBe("contradiction");
  });

  it("returns empty array when LLM finds no issues", async () => {
    const mockClient: LlmClient = {
      async compare() { return []; },
    };

    const flags = await runBatchComparison(candidates, canonicals, {
      model: "claude-haiku-4-5-20251001",
      llmClient: mockClient,
    });

    expect(flags).toHaveLength(0);
  });

  it("retries once on invalid JSON, then returns empty array with no throw", async () => {
    let calls = 0;
    const mockClient: LlmClient = {
      async compare() {
        calls++;
        throw new Error("bad json");
      },
    };

    const flags = await runBatchComparison(candidates, canonicals, {
      model: "claude-haiku-4-5-20251001",
      llmClient: mockClient,
    });

    expect(flags).toEqual([]);
    expect(calls).toBe(2); // tried twice
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -10
```

Expected: FAIL — `runBatchComparison` not implemented.

- [ ] **Step 3: Implement `runBatchComparison` in `triage.ts`**

Replace the stub `LlmClient` and `runBatchComparison`-related exports with:

```typescript
export interface LlmClient {
  compare(
    candidates: DocMeta[],
    canonicals: DocMeta[],
    model: string,
  ): Promise<TriageLlmFlag[]>;
}

export interface TriageLlmFlag {
  candidatePath: string;
  flagType: "contradiction" | "duplicate";
  canonicalPath?: string;
  reason: string;
}

export interface BatchComparisonOptions {
  model: string;
  llmClient?: LlmClient;
}

/**
 * Resolves the triage model ID.
 * Order: POLARIS_TRIAGE_MODEL env → provided model string → haiku fallback.
 */
export function resolveTriageModel(configured?: string): string {
  return (
    process.env["POLARIS_TRIAGE_MODEL"] ??
    configured ??
    "claude-haiku-4-5-20251001"
  );
}

/**
 * Sends one batch of candidates + canonical summaries to the LLM.
 * Retries once on error, then returns [] with a stderr warning.
 */
export async function runBatchComparison(
  candidates: DocMeta[],
  canonicals: DocMeta[],
  options: BatchComparisonOptions,
): Promise<TriageLlmFlag[]> {
  const client = options.llmClient ?? (await buildDefaultLlmClient());

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await client.compare(candidates, canonicals, options.model);
    } catch (err) {
      if (attempt === 0) {
        process.stderr.write(
          `[triage] LLM batch failed (attempt 1), retrying: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      } else {
        process.stderr.write(
          `[triage] LLM batch failed (attempt 2), skipping batch: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  return [];
}

async function buildDefaultLlmClient(): Promise<LlmClient> {
  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";

  // Dynamic import so @anthropic-ai/sdk is optional at install time
  // (same pattern as src/cli/adopt-genesis.ts)
  // @ts-ignore
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = (mod as { default: new (o: { apiKey: string }) => unknown }).default;
  const client = new (Anthropic as new (o: { apiKey: string }) => {
    messages: {
      create: (o: {
        model: string;
        max_tokens: number;
        messages: { role: string; content: string }[];
      }) => Promise<{ content: { type: string; text: string }[] }>;
    };
  })({ apiKey });

  return {
    async compare(candidates, canonicals, model) {
      const candidateSummaries = candidates
        .map((c, i) => `[${i}] ${basename(c.path)} (${c.type || "unknown type"}) tags: ${c.tags.join(", ") || "none"}`)
        .join("\n");

      const canonicalSummaries = canonicals
        .map((c) => `- ${basename(c.path)} (${c.type || "unknown type"}) tags: ${c.tags.join(", ") || "none"}`)
        .join("\n");

      const prompt = [
        "You are comparing candidate documentation files against canonical documentation.",
        "Identify any candidates that CONTRADICT or DUPLICATE a canonical.",
        "Return ONLY a JSON array. If no issues found, return [].",
        "Each item must be: { \"candidatePath\": string, \"flagType\": \"contradiction\" | \"duplicate\", \"canonicalPath\"?: string, \"reason\": string }",
        "",
        "CANDIDATES:",
        candidateSummaries,
        "",
        "CANONICALS:",
        canonicalSummaries,
        "",
        "Respond with JSON only. No prose.",
      ].join("\n");

      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      // Strip markdown code fences if present
      const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
      return JSON.parse(cleaned) as TriageLlmFlag[];
    },
  };
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/triage.ts src/smartdocs-engine/triage.test.ts && git commit -m "feat(triage): implement runBatchComparison with injectable LLM client"
```

---

## Task 6: Graph check (Phase 2)

**Files:**
- Modify: `src/smartdocs-engine/triage.ts` — implement `runGraphCheck`
- Modify: `src/smartdocs-engine/triage.test.ts` — add tests

`runGraphCheck` scans each candidate's content for symbol references, looks them up in the graph, and flags candidates where 2+ symbols are missing.

- [ ] **Step 1: Add tests for `runGraphCheck`**

Add to `src/smartdocs-engine/triage.test.ts`:

```typescript
import { runGraphCheck } from "./triage.js";

describe("runGraphCheck", () => {
  it("skips check when symbolCount < 1000", () => {
    const candidates: DocMeta[] = [
      { path: "smartdocs/doctrine/candidate/foo.md", tags: [], type: "", clusterMembership: [], relatedNotes: [], filenamePrefixes: [] },
    ];

    const flags = runGraphCheck(candidates, {
      getContent: () => "References `runTriage` and `TriageRunner` symbols.",
      symbolLookup: () => false,
      graphStats: () => ({ symbolCount: 50 }),
    });

    expect(flags).toHaveLength(0); // skipped due to low coverage
  });

  it("flags candidate with 2+ missing symbols", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-graph-"));
    const docPath = join(dir, "stale.md");
    writeFileSync(docPath, "Call `runTriage` then `TriageRunner` and `clusterCandidates`.", "utf-8");

    const candidates: DocMeta[] = [
      { path: docPath, tags: [], type: "", clusterMembership: [], relatedNotes: [], filenamePrefixes: [] },
    ];

    const flags = runGraphCheck(candidates, {
      getContent: (p) => readFileSync(p, "utf-8"),
      symbolLookup: () => false, // all symbols missing
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0].flagType).toBe("stale-reference");
    expect(flags[0].staleSymbols!.length).toBeGreaterThanOrEqual(2);
  });

  it("does not flag candidate with only 1 missing symbol", () => {
    const dir = mkdtempSync(join(tmpdir(), "triage-graph-"));
    const docPath = join(dir, "ok.md");
    writeFileSync(docPath, "Call `onlyMissing` and some text without symbols.", "utf-8");

    const candidates: DocMeta[] = [
      { path: docPath, tags: [], type: "", clusterMembership: [], relatedNotes: [], filenamePrefixes: [] },
    ];

    const flags = runGraphCheck(candidates, {
      getContent: (p) => readFileSync(p, "utf-8"),
      symbolLookup: () => false,
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(flags).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -10
```

Expected: FAIL — `runGraphCheck` not exported.

- [ ] **Step 3: Implement `runGraphCheck` in `triage.ts`**

Add after `buildDefaultLlmClient`:

```typescript
export interface GraphCheckOptions {
  getContent: (path: string) => string;
  symbolLookup: (name: string) => boolean;
  graphStats: () => { symbolCount: number };
}

export interface GraphFlag {
  candidatePath: string;
  flagType: "stale-reference";
  staleSymbols: string[];
}

const STALE_SYMBOL_THRESHOLD = 2;
const GRAPH_SYMBOL_MINIMUM = 1000;

/**
 * Phase 2: checks each candidate for stale code symbol references.
 * Returns flags for candidates with 2+ symbols not found in the graph.
 * No-ops if the graph has fewer than 1000 symbols indexed.
 */
export function runGraphCheck(
  candidates: DocMeta[],
  options: GraphCheckOptions,
): GraphFlag[] {
  const stats = options.graphStats();

  if (stats.symbolCount < GRAPH_SYMBOL_MINIMUM) {
    process.stderr.write(
      `[triage] Graph coverage too low for doc-vs-code check (${stats.symbolCount} symbols indexed).\n` +
      `         Run: polaris-cli graph build\n`,
    );
    return [];
  }

  const flags: GraphFlag[] = [];

  for (const candidate of candidates) {
    let content = "";
    try {
      content = options.getContent(candidate.path);
    } catch {
      continue;
    }

    const symbols = extractSymbols(content);
    const missing = symbols.filter((s) => !options.symbolLookup(s));

    if (missing.length >= STALE_SYMBOL_THRESHOLD) {
      flags.push({
        candidatePath: candidate.path,
        flagType: "stale-reference",
        staleSymbols: missing,
      });
    }
  }

  return flags;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 5: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/triage.ts src/smartdocs-engine/triage.test.ts && git commit -m "feat(triage): implement runGraphCheck with injectable symbol lookup"
```

---

## Task 7: `runTriage` orchestrator

**Files:**
- Modify: `src/smartdocs-engine/triage.ts` — replace stub `runTriage` with full implementation
- Modify: `src/smartdocs-engine/triage.test.ts` — add orchestrator tests

`runTriage` ties everything together: load docs, cluster, batch compare, graph check, write outputs, delete checkpoint.

- [ ] **Step 1: Add orchestrator tests**

Add to `src/smartdocs-engine/triage.test.ts`:

```typescript
import { runTriage } from "./triage.js";
import type { TriageOptions } from "./triage.js";

describe("runTriage", () => {
  function makeTriageRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "triage-orch-"));
    mkdirSync(join(dir, "smartdocs", "doctrine", "active"), { recursive: true });
    mkdirSync(join(dir, "smartdocs", "doctrine", "candidate"), { recursive: true });
    mkdirSync(join(dir, "smartdocs", "raw"), { recursive: true });

    writeFileSync(
      join(dir, "smartdocs", "doctrine", "active", "ADR-001.md"),
      "---\nTags: [governance]\nType: Decision\n---\n# ADR-001\nGoverns dual metric system.",
      "utf-8",
    );

    writeFileSync(
      join(dir, "smartdocs", "doctrine", "candidate", "ADR-101.md"),
      "---\nTags: [governance]\nType: Decision\n---\n# ADR-101\nContradicts ADR-001.",
      "utf-8",
    );

    return dir;
  }

  it("writes _triage-queue.json when flags are found", async () => {
    const repoRoot = makeTriageRepo();

    const mockClient: LlmClient = {
      async compare(candidates) {
        return candidates.map((c) => ({
          candidatePath: c.path,
          flagType: "contradiction" as const,
          canonicalPath: "smartdocs/doctrine/active/ADR-001.md",
          reason: "Contradicts the canonical.",
        }));
      },
    };

    const result = await runTriage({
      repoRoot,
      batchSize: 10,
      llmClient: mockClient,
      symbolLookup: () => true, // all symbols found → no stale flags
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(result.flagCount).toBeGreaterThan(0);
    expect(existsSync(join(repoRoot, "smartdocs", "raw", "_triage-queue.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "smartdocs", "raw", "_triage-report.md"))).toBe(true);
  });

  it("dry-run prints estimate and writes no files", async () => {
    const repoRoot = makeTriageRepo();
    const messages: string[] = [];

    await runTriage({
      repoRoot,
      dryRun: true,
      llmClient: { async compare() { return []; } },
      symbolLookup: () => true,
      graphStats: () => ({ symbolCount: 5000 }),
      output: (m) => messages.push(m),
    });

    expect(messages.some((m) => m.includes("Estimated"))).toBe(true);
    expect(existsSync(join(repoRoot, "smartdocs", "raw", "_triage-queue.json"))).toBe(false);
  });

  it("resumes from checkpoint, skipping completed clusters", async () => {
    const repoRoot = makeTriageRepo();
    const outputDir = join(repoRoot, "smartdocs", "raw");

    // Pre-write a checkpoint that marks the only cluster as done
    const { writeTriageCheckpoint } = await import("./triage.js");
    writeTriageCheckpoint({ completedClusters: ["governance", "decision", "general"], flags: [] }, outputDir);

    let compareCalls = 0;
    const mockClient: LlmClient = {
      async compare() { compareCalls++; return []; },
    };

    await runTriage({
      repoRoot,
      llmClient: mockClient,
      symbolLookup: () => true,
      graphStats: () => ({ symbolCount: 5000 }),
    });

    expect(compareCalls).toBe(0); // all clusters already done
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -10
```

Expected: FAIL — `runTriage` throws "not implemented".

- [ ] **Step 3: Replace the `runTriage` stub in `triage.ts`**

Replace the stub `runTriage` at the bottom of `triage.ts` with:

```typescript
export async function runTriage(options: TriageOptions): Promise<TriageResult> {
  const {
    repoRoot,
    batchSize = 10,
    dryRun = false,
    output = (m: string) => process.stdout.write(m + "\n"),
    llmClient,
    symbolLookup,
    graphStats,
  } = options;

  const activeDir = join(repoRoot, "smartdocs", "doctrine", "active");
  const candidateDir = join(repoRoot, "smartdocs", "doctrine", "candidate");
  const outputDir = join(repoRoot, "smartdocs", "raw");

  output(`Loading canonical docs from ${activeDir}...`);
  const canonicals = loadAllDocMeta(activeDir);

  output(`Loading candidate docs from ${candidateDir}...`);
  const candidates = loadAllDocMeta(candidateDir);

  output(`Clustering ${candidates.length} candidates against ${canonicals.length} canonicals...`);
  const clusterMap = clusterCandidates(candidates, canonicals);

  const clusterNames = Object.keys(clusterMap).filter((k) => k !== "general");
  if (clusterMap["general"]) clusterNames.push("general");

  if (dryRun) {
    const batchCount = clusterNames.reduce((sum, name) => {
      return sum + Math.ceil((clusterMap[name].candidates.length || 0) / batchSize);
    }, 0);
    output(`  ${clusterNames.length} clusters identified`);
    output(`  Estimated batches: ${batchCount}`);
    output(`  Estimated tokens: ~${batchCount * 3000} input / ~${batchCount * 200} output`);
    output(`  Model: ${resolveTriageModel()} (configured)`);
    output(`\nRun without --dry-run to execute.`);
    return { flagCount: 0, outputDir };
  }

  // Load checkpoint if resuming
  let checkpoint = readTriageCheckpoint(outputDir);
  const completedClusters = new Set(checkpoint?.completedClusters ?? []);
  const accumulatedFlags: TriageLlmFlag[] = [...(checkpoint?.flags ?? [])];

  if (completedClusters.size > 0) {
    output(`Resuming triage from checkpoint (${completedClusters.size}/${clusterNames.length} clusters complete)...`);
  }

  const model = resolveTriageModel();

  // Phase 1: doc-vs-doc
  for (const clusterName of clusterNames) {
    if (completedClusters.has(clusterName)) continue;

    const cluster = clusterMap[clusterName];
    if (cluster.candidates.length === 0) {
      completedClusters.add(clusterName);
      continue;
    }

    output(`  Comparing cluster "${clusterName}" (${cluster.candidates.length} candidates, ${cluster.canonicals.length} canonicals)...`);

    // Batch the candidates
    for (let i = 0; i < cluster.candidates.length; i += batchSize) {
      const batch = cluster.candidates.slice(i, i + batchSize);
      const flags = await runBatchComparison(batch, cluster.canonicals, {
        model,
        llmClient,
      });
      accumulatedFlags.push(...flags);
    }

    completedClusters.add(clusterName);
    writeTriageCheckpoint(
      { completedClusters: Array.from(completedClusters), flags: accumulatedFlags },
      outputDir,
    );
  }

  // Phase 2: doc-vs-code
  output(`Running doc-vs-code graph check...`);
  const graphFlagOptions: GraphCheckOptions = {
    getContent: (p) => readFileSync(p, "utf-8"),
    symbolLookup: symbolLookup ?? ((name: string) => {
      const { lookupSymbol } = require("../graph/query/index.js") as { lookupSymbol: (n: string) => unknown };
      return lookupSymbol(name) !== null;
    }),
    graphStats: graphStats ?? (() => {
      const { getGraphStats } = require("../graph/query/index.js") as { getGraphStats: () => { symbolCount: number } };
      return getGraphStats();
    }),
  };

  const graphFlags = runGraphCheck(candidates, graphFlagOptions);

  // Merge all flags into TriageReviewPackets
  const allPackets: TriageReviewPacket[] = [
    ...accumulatedFlags.map((f): TriageReviewPacket => ({
      sourcePath: f.candidatePath,
      proposedDestination: f.candidatePath,
      classificationConfidence: 0,
      destinationCertainty: 0,
      authorityRisk: "medium",
      reasoning: [f.reason],
      conflicts: f.canonicalPath ? [f.canonicalPath] : [],
      recommendation: "defer",
      outcomeReason: f.reason,
      triageFlag: f.flagType,
      relatedCanonical: f.canonicalPath,
    })),
    ...graphFlags.map((f): TriageReviewPacket => ({
      sourcePath: f.candidatePath,
      proposedDestination: f.candidatePath,
      classificationConfidence: 0,
      destinationCertainty: 0,
      authorityRisk: "low",
      reasoning: [`Stale symbol references: ${f.staleSymbols.join(", ")}`],
      conflicts: [],
      recommendation: "defer",
      outcomeReason: `${f.staleSymbols.length} code symbols not found in graph: ${f.staleSymbols.join(", ")}`,
      triageFlag: "stale-reference",
      staleSymbols: f.staleSymbols,
    })),
  ];

  writeTriageQueue(allPackets, outputDir);
  deleteTriageCheckpoint(outputDir);

  output(`\nTriage complete: ${allPackets.length} flags written to ${outputDir}/_triage-queue.json`);
  output(`Run \`polaris docs review\` to walk through decisions.`);

  return { flagCount: allPackets.length, outputDir };
}
```

- [ ] **Step 4: Fix `deleteTriageCheckpoint` to be synchronous**

Add `unlinkSync` to the existing import at the top of `triage.ts`:

```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
```

Replace the `deleteTriageCheckpoint` function with:

```typescript
export function deleteTriageCheckpoint(outputDir: string): void {
  const p = join(outputDir, CHECKPOINT_FILENAME);
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
}
```

- [ ] **Step 5: Run tests — expect pass**

```bash
cd ~/Developer/Polaris && npx vitest run src/smartdocs-engine/triage.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

- [ ] **Step 6: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/triage.ts src/smartdocs-engine/triage.test.ts && git commit -m "feat(triage): implement runTriage orchestrator with checkpoint resume and dry-run"
```

---

## Task 8: CLI wiring

**Files:**
- Modify: `src/smartdocs-engine/index.ts` — add `docs triage` command

- [ ] **Step 1: Add the import**

At the top of `src/smartdocs-engine/index.ts`, after the existing imports, add:

```typescript
import { runTriage } from "./triage.js";
```

- [ ] **Step 2: Add the `triage` command**

In `src/smartdocs-engine/index.ts`, find the line `docs.command("review")` block and after its `.action(...)` call, add:

```typescript
  docs
    .command("triage")
    .description("Detect contradictions, duplicates, and stale code references among candidate docs")
    .option("-r, --repo-root <path>", "Repository root", process.cwd())
    .option("--batch-size <n>", "Docs per LLM call", "10")
    .option("--resume", "Resume from last checkpoint (auto-detected by default)")
    .option("--dry-run", "Plan batches and print cost estimate without calling the LLM")
    .action(async (options: { repoRoot: string; batchSize: string; resume?: boolean; dryRun?: boolean }) => {
      try {
        await runTriage({
          repoRoot: options.repoRoot,
          batchSize: parseInt(options.batchSize, 10) || 10,
          resume: options.resume,
          dryRun: options.dryRun,
        });
      } catch (err) {
        console.error(`polaris docs triage: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
```

- [ ] **Step 3: Build**

```bash
cd ~/Developer/Polaris && npm run build 2>&1 | tail -5
```

Expected: no errors.

- [ ] **Step 4: Smoke-test the CLI**

```bash
cd ~/Developer/git-fit && polaris-cli docs triage --dry-run
```

Expected: output showing cluster count, batch estimate, model name, no LLM calls.

- [ ] **Step 5: Commit**

```bash
cd ~/Developer/Polaris && git add src/smartdocs-engine/index.ts && git commit -m "feat(triage): wire docs triage CLI command"
```

---

## Task 9: Full test run and publish

**Files:** none new — verification and release only

- [ ] **Step 1: Run full test suite**

```bash
cd ~/Developer/Polaris && npx vitest run 2>&1 | tail -20
```

Expected: all tests pass, no regressions in governance, ingest, or review tests.

- [ ] **Step 2: Run dry-run against EVO**

```bash
cd ~/Developer/git-fit && polaris-cli docs triage --dry-run
```

Expected: prints cluster count, batch count, estimated cost. No errors.

- [ ] **Step 3: Run a small live triage batch against EVO** (requires `ANTHROPIC_API_KEY`)

```bash
cd ~/Developer/git-fit && polaris-cli docs triage --batch-size 5
```

Expected: `_triage-queue.json` and `_triage-report.md` written to `smartdocs/raw/`. Checkpoint deleted on success.

- [ ] **Step 4: Bump version and publish**

```bash
cd ~/Developer/Polaris && npm version minor && npm run build
# Then ask user to run: npm publish --access public
```

Expected: version bumped to `0.3.0`.
