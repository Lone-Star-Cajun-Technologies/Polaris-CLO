# Summary: smartdocs-engine

## Purpose
Smart Docs lifecycle pipeline — ingests, classifies, seeds, validates, and audits documentation in the Polaris canonical authority structure (`smartdocs/`).

## Key behaviors
- `smartdocs/` is the canonical authority structure; everything outside it is raw or unclassified.
- Explicit doctrine lifecycle commands are one-way: candidate → active → deprecated. No reversal.
- `ingestDocs` auto-promotes doctrine-classified documents into `smartdocs/doctrine/active/` and emits `doc-auto-promoted` telemetry for non-dry-run promotions.
- `DRAFT_MARKER` guards seeded files from re-seeding over human edits.
- `classifyDoc` is deterministic — no external calls or randomness.
- Canon-check emits telemetry only; it does not block execution.
- Seed operations (POLARIS.md, SUMMARY.md) skip root by default.
- Generated runtime artifacts such as `.polaris/graph/**`, SQLite files, and DB snapshots are ignored by default.

## Relationships
- **Upstream**: `src/map` (atlas signals for seed templates), `src/cognition` (validation after seed)
- **Triggered by**: `src/loop/worker.ts` (canon-check after child), `polaris docs` CLI commands

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `.smartdocignore`
