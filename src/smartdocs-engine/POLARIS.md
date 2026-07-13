<!-- BEGIN POLARIS GENERATED -->
<!-- polaris:template-version: 1 -->
# smartdocs-engine

## Purpose

Smart Docs lifecycle pipeline — ingests, classifies, seeds, validates, promotes, and audits documentation in the Polaris canonical authority structure (`smartdocs/`), plus the POLARIS.md/SUMMARY.md seeding, canon-check, and instruction-validation tooling used by adoption and CI.

**Domain:** smartdocs-engine
**Route:** src/smartdocs-engine
**Taskchain:** polaris-smartdocs-engine

## What belongs here

- `index.ts` — `docs` and `doctrine` Commander command groups (ingest, promote, deprecate, spec-promote, seed-instructions, seed-index, migrate, reformat-okf, validate-instructions)
- `ingest.ts` / `migrate.ts` / `review.ts` / `triage.ts` / `audit.ts` — Smart Docs lifecycle stages (classify, migrate legacy layouts, promotion review, raw-doc triage, periodic audit)
- `doctrine.ts` — doctrine candidate→active→deprecated lifecycle, frontmatter parsing, link-staleness checking (`checkSmartDocsLinks`)
- `agentic-review.ts` — LLM-assisted review pass for promotion candidates
- `librarian-dispatch.ts` — resolves the provider used for Closeout Librarian dispatch
- `smartdoc-ignore.ts` — directory eligibility rules (`isDirectoryEligible`) for what gets Smart Docs coverage
- `seed-instructions.ts` — generates draft POLARIS.md/SUMMARY.md/index.md scaffolds (`generateDraft`, `generateSummaryDraft`) guarded by `DRAFT_MARKER`/`GENERATED_START_MARKER`/`GENERATED_END_MARKER`/`TEMPLATE_VERSION`; `hasDraftMarker()` prevents re-seeding over human edits
- `canon-check.ts` — compares changed files against the nearest POLARIS.md's modal-verb (`must`/`never`/`always`/...) assertions and classifies drift as `aligned`, `stale-implementation`, `stale-docs`, or `candidate-divergence`; telemetry-only, never blocks execution
- `validate-instructions.ts` — validates seeded/promoted POLARIS.md/SUMMARY.md against source: staleness vs. last git-modified date (`getLastGitModDate`, `getFilesChangedAfter`), `Read before editing` link resolution (`parseReadBeforeEditingLinks`), pairwise drift similarity (`DEFAULT_PAIRWISE_DRIFT_THRESHOLD`); `validateInstructions()`/`printReport()` back the `docs validate-instructions [--fix]` CLI command; findings are `OK`/`WARN`/`ERROR`/`MISSING`

## What does not belong here

- Route/file ownership resolution — delegated to `.polaris/map/file-routes.json` (`src/map`)
- Adoption scanning/CLI wiring — lives in `src/cli` (`adopt-canon.ts` calls into `seed-instructions.ts` for scaffolding)

## Editing rules

- `smartdocs/` is the canonical authority structure; everything outside it is raw or unclassified.
- Doctrine lifecycle transitions are one-way: candidate → active → deprecated. No reversal.
- Never write generated seed content over a file that lacks `DRAFT_MARKER` — that means a human has already edited it.
- `canon-check.ts` must remain telemetry-only; do not make it a hard gate without a spec change.
- `validate-instructions.ts` must not mutate files except behind explicit `--fix`.

## Architecture assumptions

- Assumes git is available for `getLastGitModDate`/`getFilesChangedAfter` staleness checks; degrades to skipping those checks when git history is unavailable.
- Assumes `.polaris/map/file-routes.json` and `readNeedsReview()` reflect current route state for seed/validate targeting.

## Read before editing

- [POLARIS.md](POLARIS.md)
- [SUMMARY.md](SUMMARY.md)
- `smartdocs/specs/active/docs-authority-model.md`

## Related routes

- `src/cli/adopt-canon.ts` — canon adoption phase, drives `seed-instructions.ts`
- `src/map/` — file-routes source of truth consumed by seed/validate

<!-- END POLARIS GENERATED -->