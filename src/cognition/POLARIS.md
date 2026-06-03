# src/cognition

## Purpose

The cognition subsystem provides route-local cognition helpers for both canon delta detection and reconciled note provenance. It determines whether a `POLARIS.md` or `SUMMARY.md` update is warranted after a child completes, detects missing surfaces, validates size and doctrine constraints, generates seed drafts, and archives reconciled cognition notes from `.polaris/cognition/pending/` into `.polaris/cognition/archive/` with per-folder provenance indexes.

## What belongs here

- `route-cognition-delta.ts` — operational signal detection and POLARIS.md delta logic
- `summary-delta.ts` — SUMMARY.md delta logic, size guard, doctrine bleed heuristic
- `validate.ts` — cognition surface validation (size, doctrine, churn)
- `archive.ts` — pending/archive note movement plus `cognition-index.json` provenance updates
- `index.ts` — public API re-exports
- `cognition.test.ts` — unit tests

## What does not belong here

- Writing `POLARIS.md` or `SUMMARY.md` files — callers own that responsibility even though archive provenance sidecars are written here.
- Atlas read/write operations — belongs in `src/map/atlas.ts`.
- CLI command registration — belongs in `src/cli/`.
- Seed draft generation (template rendering) — belongs in `src/smartdocs-engine/seed-instructions.ts`.

## Editing rules

- `isCognitionSkippedFolder` is the single authority on which folders are excluded from cognition scanning. Do not duplicate its logic elsewhere.
- Root cognition (`POLARIS.md` at repo root) is always skipped unless `skipRoot: false` is explicitly passed. Root belongs in `AGENTS.md` / `CLAUDE.md`.
- `SUMMARY_MAX_BYTES` is the hard byte cap for SUMMARY.md files. Do not raise it without updating `validate.ts` and tests.
- `hasDoctrineBled` is a heuristic and produces `warn`-severity only — never a hard blocker.
- Delta functions return signals only; only `archive.ts` may write cognition archive/provenance files.
- `looksLikePolarisChurn` normalizes whitespace before comparing — do not change the normalization logic without updating tests.
- Folder cognition coverage uses a 3-tier policy:
  1. Tier 1 (Polaris-owned): always cover `.polaris/`, `src/`, each immediate `src/<subdirectory>/`, `smartdocs/specs/active/`, and `smartdocs/doctrine/active/` when it exists.
  2. Tier 2 (adaptive): a folder is eligible only when it has at least one non-test/non-generated source file, `detectOperationalReasons()` returns a non-empty reason set for touched files in that folder, and `isCognitionSkippedFolder()` is false.
  3. Tier 3 (user protection): user-created cognition surfaces are protected from worker overwrite unless explicitly approved by an operator.

## Route model

- Cognition surfaces are route-local: one `POLARIS.md` per directory, walked upward from touched files.
- Reconciled note provenance is folder-local: each archive or pending folder keeps its own `cognition-index.json` history, and successful reconciliations also persist `.reconcile-<id>.json` beside archived notes.
- `isCognitionSkippedFolder` uses prefix matching for hard runtime exclusions (`.git/`, `node_modules/`, `dist/`, `.taskchain_artifacts/`) and treats top-level Polaris runtime folders (`.polaris/`, `.polaris/bootstrap`, `.polaris/clusters`, `.polaris/map`, `.polaris/runs`) as eligible cognition surfaces while skipping their generated descendants.
- Coverage floor: never create cognition in folders containing only test files, generated files, or hidden config; this floor is enforced through `isCognitionSkippedFolder` and adaptive eligibility checks.
- Summary delta signals are driven by file path patterns (e.g., `docs/spec/`, `docs/architecture/`), not file content.
- Operational reasons for POLARIS.md update are driven by non-test, non-comment source file changes matching known path patterns.

## Read before editing

- `src/cognition/route-cognition-delta.ts` — skip-folder logic and operational signal patterns
- `src/cognition/summary-delta.ts` — `SUMMARY_MAX_BYTES`, doctrine bleed heuristic
- `src/cognition/validate.ts` — violation types and severity model

## Related routes

- `polaris.cognition` — all files in this directory
- `src/smartdocs-engine` — reads cognition signals for ingest and seed
- `src/loop/worker.ts` — calls `applyRouteCognitionDelta` and `applySummaryDelta` after child completes
