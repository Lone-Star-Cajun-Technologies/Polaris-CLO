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

## Telemetry surface classification

Canonical telemetry surfaces written under `.taskchain_artifacts/`:

| Surface | Classification | Notes |
| --- | --- | --- |
| `.taskchain_artifacts/polaris-run/` | Canonical | Active writer: `polaris-run` skill |
| `.taskchain_artifacts/polaris-analyze/` | Canonical | Active writer: `polaris-analyze` skill |
| `.taskchain_artifacts/polaris-doctrine/` | Canonical | Active writer: `polaris-doctrine` skill |
| `.taskchain_artifacts/polaris-docs-ingest/` | Canonical | Current name after rename from `docs-ingest` |
| `.taskchain_artifacts/docs-ingest/` | Compatibility-only | Legacy name; preserved for reference, no active writer |
| `.taskchain_artifacts/polaris-docs-migrate/` | Compatibility-only | One-off migration; no active writer |
| `.taskchain_artifacts/bootstrap-run/` | Removed | Deprecated scratch surface; no active skill writes here. |
| `.taskchain_artifacts/evo-run/` | Removed | Deprecated; no active skill. Archived to `.polaris/runs/evo-run-archive/`. |

### bootstrap-run note

`bootstrap-run` is deprecated. Active runtime fallbacks now target `.taskchain_artifacts/polaris-run/`, and historical `bootstrap-run` artifacts should remain untracked workspace scratch only.

### worker-acknowledged gap (POL-215 scope)

The `worker-acknowledged` telemetry event is not yet emitted by any runtime writer. This is a known implementation gap. The write-telemetry specification and implementation are tracked under [POL-215](https://linear.app/lsctech/issue/POL-215).

## Related routes

- `.polaris`
- `.polaris/bootstrap`
- `.taskchain_artifacts/polaris-run`
