# src/smartdocs-engine

## Purpose

The smartdocs-engine implements the Smart Docs lifecycle for Polaris: doc ingestion and classification, POLARIS.md seed generation, instruction validation, canon checking, doctrine lifecycle, migration, and audit. It is the pipeline that keeps the `smartdocs/docs/` canonical authority structure consistent with the repo.

## What belongs here

- `ingest.ts` — doc classification and placement into `smartdocs/docs/` canonical structure
- `seed-instructions.ts` — POLARIS.md / SUMMARY.md draft generation; `DRAFT_MARKER` ownership
- `validate-instructions.ts` — POLARIS.md staleness and coverage checks
- `canon-check.ts` — behavioral assertion comparison against active doctrine/spec docs
- `doctrine.ts` — doctrine lifecycle (candidate → active → deprecated)
- `migrate.ts`, `audit.ts` — doc migration and ingest risk surface audit
- `smartdoc-ignore.ts` — ingest and seed eligibility authority
- `index.ts`, `*.test.ts` — command registration and tests

## What does not belong here

- Atlas read/write helpers — belongs in `src/map/atlas.ts`.
- Route-local cognition delta signals — belongs in `src/cognition/`.
- Session lifecycle (dispatch, continue, resume) — belongs in `src/loop/`.
- Config loading — belongs in `src/config/`.

## Editing rules

- `DRAFT_MARKER` (`<!-- polaris:draft -->`) is the canonical marker for seeded-but-unfilled cognition files. Do not change the marker string without updating all consumers.
- `seedInstructions` / `seedSummary` skip files that already exist without the draft marker. This protects human-edited cognition surfaces.
- `seedInstructionsAll` / `seedSummaryAll` skip root by default. Do not add root seeding to these functions.
- `isDirectoryEligible` is the gating function for seed eligibility. Runtime, hidden, and agent folders are excluded unless explicitly opted in.
- `runCanonCheck` is called by the loop worker after a child completes. It must not mutate state beyond JSONL telemetry.
- Ingest classification (`classifyDoc`) must remain deterministic — no randomness or external calls.
- Doctrine lifecycle is one-way: draft → promote (active) → deprecate. No reversal.

## Route model

- The `smartdocs/docs/` directory is the canonical authority structure. Docs outside it are considered raw or unclassified.
- `.smartdocignore` file at repo root controls which files/directories are excluded from ingest and seed operations.
- Canon-check compares touched file content against behavioral assertions (modal verbs) in doctrine/spec files under `smartdocs/docs/doctrine/active/` and `smartdocs/docs/specs/active/`.
- Seed operations read the atlas (`file-routes.json`, `needs-review.json`) to provide domain/route/taskchain context in draft templates.

## Read before editing

- `src/smartdocs-engine/seed-instructions.ts` — `DRAFT_MARKER`, template generation logic
- `src/smartdocs-engine/smartdoc-ignore.ts` — eligibility rules used by seed and ingest
- `src/cognition/validate.ts` — cognition constraints applied post-seed
- `.smartdocignore` — repo-level ignore patterns

## Related routes

- `polaris.smartdocs-engine` — all files in this directory
- `src/cognition` — validates cognition surfaces after seed
- `src/map` — provides atlas signals to seed-instructions and validate-instructions
