# Summary: clusters

## Purpose
Per-cluster runtime artifact root for Polaris execution.

## Key behaviors
- Each cluster ID gets its own generated artifact directory.
- `clusters.json` captures tracker graph state; packets and results capture worker dispatch evidence.
- Cognition is folder-level only; generated cluster descendants stay excluded from route-local canon.

## Relationships
- **Written by**: `src/tracker`, `src/loop`, `src/cluster-state`
- **Consumed by**: continuation, status, and audit flows

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `../../src/cluster-state/store.ts`
