# Summary: map

## Purpose
Repository file-route index (atlas) — infers domain/route/taskchain ownership for each file and maintains the sidecar atlas at `.polaris/map/`.

## Key behaviors
- Atlas is append-safe: incremental updates merge into existing entries.
- `instructionFile` is resolved at index/update time by walking upward to the nearest `POLARIS.md`.
- All atlas writes go through `atlas.ts` helpers — direct `fs` writes bypass integrity checks.
- Validation reports route identity incompleteness when `instructionFile` or `role_owner` is missing; invalid `role_owner` values remain errors.
- Welfare checks read atlas entries and report route health/action requirements without mutating sidecar files.
- Map does not call `git push` or mutate execution state.
- Generated graph artifacts under `.polaris/graph/` are ignored by validation and review counts.

## Relationships
- **Read by**: `src/loop`, `src/finalize`, `src/cognition`, `src/smartdocs-engine`
- **Upstream**: `src/config` (inference thresholds), `src/ignore` (filter patterns)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `smartdocs/specs/active/docs-authority-model.md`
- `smartdocs/specs/active/polaris-implementation-plan.md`
