# src/map

## Purpose

The map subsystem is the Polaris sidecar atlas. It scans the repository, infers route/domain/taskchain ownership for each file, and maintains three output files: `file-routes.json` (indexed entries), `needs-review.json` (low-confidence entries), and `index.json` (summary metrics). It also resolves `instructionFile` pointers to `POLARIS.md` files during indexing and updates.

## What belongs here

- `atlas.ts` — atlas data types and all JSON read/write helpers (single source of truth)
- `inference.ts` — route/domain/taskchain inference engine
- `update.ts` — incremental changed-file mapping (`polaris map update --changed`)
- `validate.ts` — atlas integrity checks and stale-entry detection
- `welfare.ts` — read-only route welfare reporting; classifies route identity completeness, health state, and required review action
- `index.ts`, `backfill.ts`, `query.ts` — command registration, gap-fill, query lookup
- `*.test.ts` — unit tests

## What does not belong here

- Session state management — belongs in `src/loop/`
- Config loading — belongs in `src/config/`
- CLI entry point — belongs in `src/cli/`
- Finalization delivery steps — belongs in `src/finalize/`
- Graph governance runtime output — belongs in `.polaris/graph/`, not the atlas

## Editing rules

- `atlas.ts` is the single source of truth for all atlas data types. Do not duplicate `FileRouteEntry` or `AtlasIndex` interfaces elsewhere.
- `resolveInstructionFile` walks up from a file's directory. The resolution logic must stay aligned with the SmartDocs authority model and local instruction-file migration guidance.
- `computeInstructionCoverage` counts entries with `instructionFile !== undefined`. Do not filter by classification.
- All atlas JSON writes go through the helpers in `atlas.ts` (`writeFileRoutes`, `writeAtlasIndex`, etc.) — never write directly with `fs`.
- `needs-review.json` entries must not silently overwrite `file-routes.json` entries on subsequent index runs.
- `runMapValidate` ignores `.polaris/graph/` artifacts for missing-file, coverage, and low-confidence checks because they are generated graph runtime data.
- `runMapValidate` reports identity-incomplete entries when `instructionFile` or `role_owner` is missing, while invalid `role_owner` values remain hard errors.
- `map welfare-check` is safe/read-only and reports route health from atlas entries without mutating sidecar files.

## Route model

- The atlas is append-safe: incremental `update --changed` merges into existing entries rather than replacing the whole file.
- `instructionFile` is resolved at index/update time, not at query time.
- Confidence threshold for auto-write is configurable via `config.map.autoWriteAbove` (default `0.85`).
- The map subsystem never directly executes git commands — it receives changed file paths as arguments or via the update helper.
- Route welfare checks derive health from atlas freshness and identity completeness; they fail the CLI command only when review is required.
- Generated graph output under `.polaris/graph/` is excluded from atlas validation and review bookkeeping.

## Read before editing

- `smartdocs/specs/active/docs-authority-model.md` — SmartDocs authority levels and local instruction-file migration context
- `smartdocs/specs/active/polaris-implementation-plan.md` — how map fits into the loop/map/finalize triad
- `src/config/schema.ts` — `PolarisConfig` fields that affect map behavior (`map.autoWriteAbove`, `repo.sidecarOutputPath`)
- `src/graph/governance.ts` — graph runtime output that atlas validation must ignore

## Related routes

- `polaris.map` — all files in this directory
