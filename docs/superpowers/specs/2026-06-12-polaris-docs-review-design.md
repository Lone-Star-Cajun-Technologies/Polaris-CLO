# `polaris docs review` — Design Spec

**Date:** 2026-06-12
**Status:** approved
**Scope:** new `src/smartdocs-engine/review.ts` + CLI wiring in `src/smartdocs-engine/index.ts`

---

## Problem

`polaris docs ingest` now writes a `_review-queue.json` when documents require human routing decisions. There is no command to work through that queue. Users must hand-edit JSON, which is impractical at scale (EVO has 1006+ documents pending).

---

## Goal

A terminal command that walks through undecided review packets one at a time, captures keypress decisions, persists them immediately to `_review-queue.json`, and automatically triggers `docs ingest` when the session completes.

---

## Command Interface

```
polaris docs review [options]

Options:
  --queue <path>       path to _review-queue.json
                       (default: smartdocs/raw/_review-queue.json)
  -r, --repo-root      repository root (default: cwd)
  -h, --help
```

**No queue file found:**
```
No review queue found. Run polaris docs ingest first.
```

**Queue fully decided:**
```
Nothing to review. Queue is fully decided — run polaris docs ingest to apply.
```

---

## Packet Display Format

Each undecided packet is shown as a compact card. Progress counter shows position in the undecided set.

```
─────────────────────────────────────────────────────────────────
[3/12] smartdocs/raw/ADR-001 - Dual Metric Learning Doctrine.md
  → smartdocs/doctrine/candidate/ADR-001 - Dual Metric Learning Doctrine.md
  Authority risk:  MEDIUM
  Recommendation:  defer

[a]pprove  [r]eject  [d]efer  [s]kip  [q]uit
─────────────────────────────────────────────────────────────────
```

**Fields shown:** source path, proposed destination, authority risk, polaris recommendation.
Confidence scores, reasoning strings, and conflicts are intentionally omitted (essentials-only).

**Key actions:**
- `a` — approve: set `reviewDecision: "approve"`
- `r` — reject: set `reviewDecision: "reject"`
- `d` — defer: set `reviewDecision: "defer"`
- `s` — skip: leave undecided, move to next packet (does not write a decision)
- `q` — quit: save all decisions made so far, exit 0, no ingest triggered

Single keypress, no Enter required. Uses Node `readline` with stdin in raw mode.

---

## Session Mechanics

### Decision persistence

Each decision (`a`, `r`, `d`) is written to `_review-queue.json` immediately — not batched. `reviewedAt` is set to the current ISO timestamp. `reviewedBy` is populated from `git config user.name` (falls back to `"unknown"` if git is unavailable).

### Resume

Undecided packets = packets with no `reviewDecision` field. A session works through only undecided packets. Running `polaris docs review` again after quitting mid-session resumes from the first remaining undecided packet.

### Completion

When the last undecided packet in the session is decided, the command prints a summary and auto-triggers `ingestDocs`:

```
Review complete: 8 approved, 2 rejected, 2 deferred.
Running docs ingest to apply decisions...
```

`ingestDocs` is called with the same `repoRoot` and default thresholds (`confidenceThreshold: 0.75`, `destinationCertaintyThreshold: 0.70`). Results are printed in the same format as `polaris docs ingest --dry-run` output.

**Approved packets** move to their `proposedDestination`.
**Rejected packets** stay in `raw/` — their `reviewDecision: "reject"` is preserved in the queue.
**Deferred packets** have `reviewDecision: "defer"` set and remain in the queue. On re-ingest, deferred packets are left in `raw/` and remain in the queue for the next review session.

### Quit mid-session

```
Session ended. 4 decisions saved, 8 packets still pending.
Run polaris docs review to continue.
```

Exits 0. No ingest triggered.

---

## Architecture

### New files

**`src/smartdocs-engine/review.ts`**
Owns the full review session: load queue, filter undecided, iterate with keypress loop, write decisions after each keypress, print summary, trigger `ingestDocs` on completion.

Uses:
- `readReviewQueue(outputDir)` from `../governance/index.js` — load queue
- `writeReviewQueue(packets, runId, outputDir)` from `../governance/index.js` — persist after each decision
- `ingestDocs(files, options)` from `./ingest.js` — apply decisions on completion

Does not read or write `_review-queue.json` directly — all queue I/O goes through the governance module.

**`src/smartdocs-engine/review.test.ts`**
Unit tests using mocked readline and mocked `ingestDocs`:
- Undecided packets shown in order
- `a`/`r`/`d` writes correct `reviewDecision` + `reviewedAt` + `reviewedBy`
- `s` skips without writing
- `q` exits without triggering ingest
- Completing all packets triggers ingest
- Empty queue / fully-decided queue prints correct message and exits without prompting

### Modified files

**`src/smartdocs-engine/index.ts`**
Add `.command("review")` to the `docs` command group, wired to a thin action handler that calls the session function from `review.ts`.

### No new dependencies

Uses Node built-ins only: `readline`, `process.stdin`, `child_process` (for `git config user.name`).

---

## What This Is Not

- Not a bulk-approval tool (no `--approve-all` flag — that's a future addition)
- Not a TUI (no `ink` dependency)
- Not a replacement for `_review-queue.md` (markdown remains display-only)
- `review.ts` does not own queue file format — that stays in `governance/review-packet.ts`
