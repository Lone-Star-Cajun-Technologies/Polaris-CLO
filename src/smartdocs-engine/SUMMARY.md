# Summary: smartdocs-engine

## Purpose
Smart Docs lifecycle pipeline — ingests, classifies, seeds, validates, promotes, and audits documentation in the Polaris canonical authority structure (`smartdocs/`).

## Key behaviors
- `smartdocs/` is the canonical authority structure; everything outside it is raw or unclassified.
- Explicit doctrine lifecycle commands are one-way: candidate → active → deprecated. No reversal.
- `ingestDocs` auto-promotes doctrine-classified documents into `smartdocs/doctrine/active/` and emits `doc-auto-promoted` telemetry for non-dry-run promotions.
- `DRAFT_MARKER` guards seeded files from re-seeding over human edits.
- The seed surface covers `POLARIS.md`, `SUMMARY.md`, and OKF-style `index.md`; index seeding is constrained to `smartdocs/` directories and skips human-edited existing indexes.
- `classifyDoc` is deterministic — no external calls or randomness.
- Canon-check emits telemetry only; it does not block execution.
- Link staleness is two-tiered: `raw/` docs are permissive while candidate and active docs are checked strictly.
- Seed operations (POLARIS.md, SUMMARY.md) skip root by default.
- Doctrine and spec lifecycle transitions write dated per-directory `log.md` entries. CLI lifecycle commands accept `--reason` for the log prose.
- Spec promotion reports advisory `suggested-supersession` conflicts when a raw candidate overlaps an active doc; it does not mutate supersession frontmatter automatically.
- SmartDocs frontmatter now reserves identity, lifecycle, governance, provenance, relationship, and future federation keys while preserving unknown extension keys.
- Generated runtime artifacts such as `.polaris/graph/**`, SQLite files, and DB snapshots are ignored by default.

## Relationships
- **Upstream**: `src/map` (atlas signals for seed templates), `src/cognition` (validation after seed)
- **Triggered by**: `src/loop/worker.ts` (canon-check after child), `polaris docs` CLI commands

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `.smartdocignore`
