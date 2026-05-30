# Summary: runs

## Purpose
Run-level ledger and archive root for Polaris execution history.

## Key behaviors
- `ledger.jsonl` is append-only run history.
- Generated `<run-id>/` directories capture archived snapshots, not source-owned docs.
- Cognition stops at `runs/`; nested run folders remain excluded from normal cognition updates.

## Relationships
- **Written by**: `src/loop/ledger.ts`, `src/finalize`
- **Related live state**: `.taskchain_artifacts/polaris-run/`

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `../../src/loop/ledger.ts`
