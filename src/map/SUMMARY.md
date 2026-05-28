# Summary: map

## Purpose
Repository file-route index (atlas) — infers domain/route/taskchain ownership for each file and maintains the sidecar atlas at `.polaris/map/`.

## Key behaviors
- Atlas is append-safe: incremental updates merge into existing entries.
- `instructionFile` is resolved at index/update time by walking upward to the nearest `POLARIS.md`.
- All atlas writes go through `atlas.ts` helpers — direct `fs` writes bypass integrity checks.
- Map does not call `git push` or mutate execution state.

## Relationships
- **Read by**: `src/loop`, `src/finalize`, `src/cognition`, `src/smartdocs-engine`
- **Upstream**: `src/config` (inference thresholds), `src/ignore` (filter patterns)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/Polaris/spec/local-instructions-layer.md`
- `docs/spec/polaris-architecture-spec.md`
