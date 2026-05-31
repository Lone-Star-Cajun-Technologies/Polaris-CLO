# clusters

## Purpose

`clusters/` holds per-parent-cluster execution artifacts: synced cluster graphs, mutable cluster-state snapshots, child packets, and worker result records.

## What belongs here

- `<cluster-id>/clusters.json` — tracker-synced child graph for a parent cluster
- `<cluster-id>/cluster-state.json` — runtime-ready cluster execution state
- `<cluster-id>/packets/` — sealed worker packets for dispatched children
- `<cluster-id>/results/` — compact worker returns and result evidence

## What does not belong here

- Global run ledger data from `.polaris/runs/`
- Live session telemetry from `.taskchain_artifacts/`
- Per-cluster cognition files inside generated `<cluster-id>/` directories

## Editing rules

- Keep cognition at the `clusters/` folder only; cluster ID directories are generated runtime descendants.
- Write `clusters.json`, `cluster-state.json`, packet, and result files through the owning runtime modules instead of manual edits.
- Preserve packet and result filenames because dispatch reconciliation keys off child IDs and dispatch UUIDs.

## Architecture assumptions

- Tracker sync owns `clusters.json`; runtime dispatch/continuation own packet, result, and cluster-state transitions.
- Cluster directories are append/overwrite runtime state, not long-form documentation surfaces.

## Read before editing

- [`src/cluster-state/store.ts`](../../src/cluster-state/store.ts)
- [`src/loop/dispatch.ts`](../../src/loop/dispatch.ts)
- [`src/loop/continue.ts`](../../src/loop/continue.ts)

## Related routes

- `.polaris`
- `.polaris/runs`
- `.taskchain_artifacts/polaris-run`
