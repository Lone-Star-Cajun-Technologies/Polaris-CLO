# map

## Purpose

`map/` stores the Polaris sidecar atlas outputs that describe repository file ownership and instruction coverage.

## What belongs here

- `file-routes.json` — indexed route entries
- `needs-review.json` — low-confidence atlas entries
- `index.json` — atlas summary metrics
- `exemptions.json` — path-level exemptions used during map validation and query flows

## What does not belong here

- Source inference logic from `src/map/`
- Smart Docs content or promoted canon
- Run or session state and telemetry

## Editing rules

- Treat the JSON files here as derived outputs; update them through `src/map/atlas.ts` helpers and map commands.
- Keep cognition at this folder level only.
- Maintain compatibility with `repo.sidecarOutputPath` because multiple commands resolve this directory from config.

## Architecture assumptions

- `src/map/` owns the schemas and all read/write helpers for this folder.
- Atlas output is durable sidecar state, but it is still derived from repository content and may be regenerated.

## Read before editing

- [`../../src/map/POLARIS.md`](../../src/map/POLARIS.md)
- [`../../src/map/atlas.ts`](../../src/map/atlas.ts)
- [`../POLARIS.md`](../POLARIS.md)

## Related routes

- `.polaris`
- `src/map`
- `src/cognition`
