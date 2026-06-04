# Summary: finalize

## Purpose
Atomic 14-step delivery sequence — the only subsystem that pushes branches, opens PRs, and performs tracker-side closeout updates.

## Key behaviors
- Steps are sequenced exclusively by `runFinalize`; steps do not call each other.
- Tracker reconciliation runs before commit and is adapter-aware (`mcp-bridge` reconciles; `linear`/`local` skip remote reconciliation).
- Remote delivery steps after the commit are skipped under `--dry-run` or `--skip-delivery`.
- Closeout Librarian gate must pass before push/PR unless `--skip-librarian` is explicitly provided.
- `stepCommit` commits durable evidence + intended source/doc changes under artifact policy.
- Only `polaris finalize` may call `git push`.

## Relationships
- **Upstream**: `src/loop/checkpoint.ts` (`current-state.json`), `src/map` (step 01 atlas update)
- **Downstream**: GitHub (PR creation), Linear (issue update)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/spec/polaris-architecture-spec.md`
