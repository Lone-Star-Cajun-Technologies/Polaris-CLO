# `polaris docs triage` — Design Spec

**Date:** 2026-06-13
**Status:** approved
**Scope:** new `src/smartdocs-engine/triage.ts` + CLI wiring in `src/smartdocs-engine/index.ts`

---

## Problem

After `polaris docs ingest` and `polaris docs review`, EVO has 415 canonical docs in `smartdocs/doctrine/active/` and 590 remaining candidates in `smartdocs/doctrine/candidate/`. There is no automated way to:

1. Detect candidates that **contradict** or **duplicate** canonicals
2. Detect candidates that reference **code symbols that no longer exist** in the codebase
3. Surface these findings for human review without paying per-doc LLM costs at full scale

---

## Goal

A `polaris docs triage` command that:
- Groups candidates into topic clusters using metadata
- Compares each cluster against relevant canonicals via LLM batch calls (Haiku, batch size 10)
- Checks all candidates against the Polaris symbol graph for stale code references
- Writes a machine-readable triage queue and a human-readable report
- Is resumable — checkpoint state survives interruption
- Produces output that feeds directly into `polaris docs review`

---

## Command Interface

```
polaris docs triage [options]

Options:
  --repo-root <path>     repository root (default: cwd)
  --batch-size <n>       docs per LLM call (default: 10)
  --resume               resume from last checkpoint (default: auto-detected)
  --dry-run              plan batches, print cost estimate, no LLM calls
  -h, --help
```

**Dry-run output:**
```
Clustering 590 candidates...
  12 clusters identified, 1 general bucket (38 docs)
  Estimated batches: 59
  Estimated tokens: ~180,000 input / ~12,000 output
  Estimated cost: ~$0.04 (claude-haiku-4-5-20251001)

Run without --dry-run to execute.
```

---

## Outputs

All written to `smartdocs/raw/`:

### `_triage-queue.json`
Machine-readable. One entry per flagged candidate. Reuses the `ReviewPacket` shape from `src/governance/types.ts` exactly — so `polaris docs review` works on triage decisions identically to ingest decisions.

Additional fields on each entry:
- `triageFlag: "contradiction" | "duplicate" | "stale-reference"`
- `relatedCanonical?: string` — path to the canonical involved (for contradiction/duplicate)
- `staleSymbols?: string[]` — symbol names not found in graph (for stale-reference)

### `_triage-report.md`
Display-only summary. Never parsed to recover decisions. Contains:
- Cluster breakdown (name, candidate count, canonical count)
- Flag count by type
- Flagged file list with one-line reasons

### `_triage-checkpoint.json`
Internal resume state. Records which clusters have been processed. Deleted automatically on successful completion. Not user-facing.

---

## Flag Types

| Flag | Meaning | Trigger |
|------|---------|---------|
| `contradiction` | Candidate makes a claim directly conflicting with a canonical | LLM batch comparison |
| `duplicate` | Candidate is substantively the same content as a canonical or another candidate | LLM batch comparison |
| `stale-reference` | Candidate references 2+ code symbols not found in the graph | Graph lookup |

All flags go to `_triage-queue.json` with `recommendation: "defer"` (requires human decision). No auto-moves.

---

## Phase 1 — Doc-vs-Doc

### Step 1: Clustering

Groups the 590 candidates into topic clusters using filename and YAML frontmatter signals:
- `Tags` field
- `Type` field
- `Member Of Concept Cluster` field
- Wikilinks in `Related Notes`
- Filename prefix patterns

No LLM needed. Pure string/metadata matching. Each candidate is assigned to the cluster whose canonicals it most closely matches. Candidates with no clear cluster signal go into a `general` bucket, processed last.

### Step 2: LLM Batch Comparison

For each cluster:
1. Collect candidate docs in that cluster (up to `--batch-size` per call)
2. Collect titles + one-line summaries of the relevant canonicals
3. Send to `claude-haiku-4-5-20251001` with a structured prompt asking only for contradictions and duplicates
4. Parse structured JSON response: array of `{ candidatePath, flagType, canonicalPath?, reason }` objects
5. Write checkpoint after each cluster batch

**Prompt contract:** the model must return valid JSON only — no prose. A batch that returns invalid JSON is retried once, then skipped with a warning logged.

### Step 3: Checkpoint

`_triage-checkpoint.json` records completed cluster IDs and their flag results. On resume (auto-detected if checkpoint exists, or forced with `--resume`), completed clusters are skipped entirely. Progress is printed:

```
Resuming triage from checkpoint (8/12 clusters complete)...
```

---

## Phase 2 — Doc-vs-Code

Runs automatically after Phase 1 completes. No additional LLM calls.

### Gate

If `getGraphStats().symbolCount < 1000`, Phase 2 is skipped:
```
⚠  Graph coverage too low for doc-vs-code check (0 symbols indexed).
   Run: polaris-cli graph build
```

### Symbol Extraction

Scan each candidate doc for likely code symbol references:
- Tokens in backticks: `` `functionName` ``
- `PascalCase` and `camelCase` identifiers in prose (min 4 chars to reduce noise)
- Regex: `/`[A-Za-z_][A-Za-z0-9_]+`|(?<![`\w])[A-Z][a-z]+(?:[A-Z][a-z]+)+(?![`\w])/g`

### Graph Lookup

For each extracted symbol, call `lookupSymbol(name)` from `src/graph/query/index.ts`. A candidate is flagged as `stale-reference` only if **2 or more** of its extracted symbols are not found in the graph. This threshold prevents false positives from external dependencies, acronyms, or prose.

### Output

Stale-reference flags are merged into the same `_triage-queue.json` and `_triage-report.md` produced by Phase 1.

---

## Architecture

### New Files

**`src/smartdocs-engine/triage.ts`**
Core logic. Owns:
- `clusterCandidates(candidates, canonicals): ClusterMap` — pure, no I/O
- `runBatchComparison(cluster, canonicals, options): TriageFlag[]` — LLM call + parse
- `runGraphCheck(candidates, repoRoot): TriageFlag[]` — symbol extraction + graph lookup
- `writeTriageQueue(flags, outputDir)` — writes JSON + MD
- `readTriageCheckpoint(outputDir): TriageCheckpoint | null`
- `writeTriageCheckpoint(checkpoint, outputDir)`
- `runTriage(options: TriageOptions): Promise<TriageResult>` — orchestrator

**`src/smartdocs-engine/triage.test.ts`**
Unit tests with mocked Anthropic SDK and mocked graph query:
- `clusterCandidates` groups correctly by tag/type/wikilink signals
- `runBatchComparison` parses valid LLM JSON response into flags
- `runBatchComparison` retries once on invalid JSON, skips on second failure
- `runGraphCheck` flags candidates with 2+ missing symbols, not 1
- `runGraphCheck` skips when `symbolCount < 1000`
- Checkpoint: resume skips already-processed clusters
- Dry-run: no LLM calls made, cost estimate printed

### Modified Files

**`src/smartdocs-engine/index.ts`**
Add `.command("triage")` to the `docs` command group, wired to a thin action handler calling `runTriage()`.

### Dependencies

No new packages. Uses:
- `@anthropic-ai/sdk` — already in Polaris
- `src/graph/query/index.ts` — `lookupSymbol`, `getGraphStats`
- `src/governance/types.ts` — `ReviewPacket` reused for triage queue entries

---

## Standard Across Polaris-Managed Repos

`polaris docs triage` reads:
- Canonicals from `smartdocs/doctrine/active/`
- Candidates from `smartdocs/doctrine/candidate/`

Both paths are discoverable from existing Polaris config — no repo-specific configuration needed beyond what `polaris docs ingest` already requires.

---

## What This Is Not

- Not a bulk-decision tool (no `--approve-all` or `--reject-duplicates` flag)
- Not a replacement for `polaris docs review` (triage flags feed into review)
- Not a semantic search system (clustering is metadata-based, not embedding-based)
- Phase 2 graph check does not verify semantic correctness — only symbol existence
