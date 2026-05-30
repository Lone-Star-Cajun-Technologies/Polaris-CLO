# runs

## Purpose

`runs/` stores global run history: the append-only ledger plus archived per-run snapshots captured during finalize and archive flows.

## What belongs here

- `ledger.jsonl` — global run ledger
- `<run-id>/` archives containing copied state, map, and report artifacts for completed or checkpointed runs
- Compatibility artifacts such as `run-report.md` or preserved historical state files when the runtime writes them

## What does not belong here

- Active live state in `.taskchain_artifacts/polaris-run/`
- Cluster-local packets and results from `.polaris/clusters/`
- Hand-authored cognition inside generated `<run-id>/` directories

## Editing rules

- Keep cognition at this folder level only; run ID directories are generated descendants.
- Update ledger and archive files through runtime or finalize code, not manual edits.
- Preserve historical artifacts unless a migration explicitly owns the rewrite.

## Architecture assumptions

- `src/loop/ledger.ts` owns ledger semantics.
- `src/finalize/steps/12-archive.ts` and related finalize flows own archived run snapshot layout.

## Read before editing

- [`src/loop/ledger.ts`](../../src/loop/ledger.ts)
- [`src/finalize/steps/12-archive.ts`](../../src/finalize/steps/12-archive.ts)
- [`../POLARIS.md`](../POLARIS.md)

## Related routes

- `.polaris`
- `.polaris/bootstrap`
- `.taskchain_artifacts/polaris-run`
