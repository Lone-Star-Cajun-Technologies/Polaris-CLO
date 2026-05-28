# Summary: finalize

## Purpose
Atomic 12-step delivery sequence — the only subsystem that pushes branches, opens PRs, and closes Linear issues.

## Key behaviors
- Steps 01–12 are sequenced exclusively by `runFinalize`; steps do not call each other.
- Steps 07–12 (remote operations) are skipped under `--dry-run` or `--skip-delivery`.
- Step 06 commits exactly: state + map + run-report. Nothing else.
- Only `polaris finalize` may call `git push`.

## Relationships
- **Upstream**: `src/loop/checkpoint.ts` (`current-state.json`), `src/map` (step 01 atlas update)
- **Downstream**: GitHub (PR creation), Linear (issue update)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/spec/polaris-architecture-spec.md`
