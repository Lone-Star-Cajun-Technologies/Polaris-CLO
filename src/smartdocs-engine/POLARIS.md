# src/smartdocs-engine

## Purpose

The smartdocs-engine implements the Smart Docs lifecycle for Polaris: doc ingestion and classification, POLARIS.md / SUMMARY.md / index.md seed generation, instruction validation, canon checking, doctrine and spec lifecycle, migration, and audit. It is the pipeline that keeps the `smartdocs/` authority structure consistent with the repo.

## What belongs here

- `ingest.ts` — doc classification and placement into the `smartdocs/` canonical structure; doctrine-classified ingest targets `smartdocs/doctrine/active/`
- `seed-instructions.ts` — POLARIS.md / SUMMARY.md draft generation plus OKF-style `index.md` generation for `smartdocs/`; `DRAFT_MARKER` ownership
- `validate-instructions.ts` — POLARIS.md staleness and coverage checks
- `canon-check.ts` — behavioral assertion comparison against active doctrine/spec docs plus two-tier link staleness checks: permissive for `raw/`, strict for candidate and active docs
- `doctrine.ts` — explicit doctrine lifecycle commands (`draft`, `promote`, `deprecate`) and spec promotion flows; writes per-directory `log.md` lifecycle entries and reports suggested supersession conflicts
- `migrate.ts`, `audit.ts` — doc migration and ingest risk surface audit
- `smartdoc-ignore.ts` — ingest and seed eligibility authority
- `index.ts`, `*.test.ts` — command registration and tests
- `.smartdocignore`-driven exclusions for generated runtime artifacts, including `.polaris/graph/**`

## What does not belong here

- Atlas read/write helpers — belongs in `src/map/atlas.ts`.
- Route-local cognition delta signals — belongs in `src/cognition/`.
- Session lifecycle (dispatch, continue, resume) — belongs in `src/loop/`.
- Config loading — belongs in `src/config/`.

## Editing rules

- `DRAFT_MARKER` (`<!-- polaris:draft -->`) is the canonical marker for seeded-but-unfilled cognition files. Do not change the marker string without updating all consumers.
- `seedInstructions` / `seedSummary` skip files that already exist without the draft marker. This protects human-edited cognition surfaces.
- `seedIndex` / `seedIndexAll` generate `index.md` files only under `smartdocs/` directories and skip human-edited existing indexes.
- `seedInstructionsAll` / `seedSummaryAll` skip root by default. Do not add root seeding to these functions.
- `isDirectoryEligible` is the gating function for seed eligibility. Runtime, hidden, and agent folders are excluded unless explicitly opted in.
- `runCanonCheck` is called by the loop worker after a child completes. It must not mutate state beyond JSONL telemetry.
- Ingest classification (`classifyDoc`) must remain deterministic — no randomness or external calls.
- Doctrine lifecycle commands are one-way: draft → promote (active) → deprecate. `ingestDocs` has a separate auto-promotion path for doctrine-classified documents.
- Doctrine and spec lifecycle transitions append dated `log.md` entries in the destination directory; the optional `--reason` flag controls the prose entry.
- `specPromote` may report `suggested-supersession` conflicts based on active-doc overlap. These are advisory until an operator chooses frontmatter relationships.
- Doctrine auto-promotion telemetry uses `doc-auto-promoted`; reserve `doctrine-promoted` for explicit lifecycle promotion.
- SmartDocs frontmatter reserves governance, provenance, relationship, and future federation keys while preserving unknown keys.
- Graph governance outputs, SQLite files, and similar runtime byproducts are ignored by default so Smart Docs only processes authoritative content.

## Route model

- The `smartdocs/` directory is the canonical authority structure. Docs outside it are considered raw or unclassified.
- `.smartdocignore` file at repo root controls which files/directories are excluded from ingest and seed operations.
- Canon-check compares touched file content against behavioral assertions (modal verbs) in doctrine/spec files under `smartdocs/doctrine/active/` and `smartdocs/specs/active/`.
- Seed operations read the atlas (`file-routes.json`, `needs-review.json`) to provide domain/route/taskchain context in draft templates.
- Index generation reads SmartDocs concept files and frontmatter labels, excluding reserved files (`index.md`, `POLARIS.md`, `SUMMARY.md`, `log.md`).
- Generated graph runtime state under `.polaris/graph/` is excluded from ingest and seed flows.

## Read before editing

- `src/smartdocs-engine/seed-instructions.ts` — `DRAFT_MARKER`, template generation logic
- `src/smartdocs-engine/smartdoc-ignore.ts` — eligibility rules used by seed and ingest
- `src/cognition/validate.ts` — cognition constraints applied post-seed
- `.smartdocignore` — repo-level ignore patterns
- `src/graph/governance.ts` — graph runtime outputs excluded from Smart Docs processing

## Related routes

- `polaris.smartdocs-engine` — all files in this directory
- `src/cognition` — validates cognition surfaces after seed
- `src/map` — provides atlas signals to seed-instructions and validate-instructions
