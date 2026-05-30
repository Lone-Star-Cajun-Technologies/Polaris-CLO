# bootstrap

## Purpose

`bootstrap/` stores sealed run bootstrap snapshots emitted before worker execution begins. Each file is a point-in-time record of the inputs used to start a governed Polaris run.

## What belongs here

- Timestamped `*.json` bootstrap snapshots emitted by run bootstrap/resume flows
- The folder-level cognition surfaces for `bootstrap/`

## What does not belong here

- Live `current-state.json` or telemetry streams
- Cluster packet/result artifacts
- Source-owned configuration or manual scratch files

## Editing rules

- Snapshot files are append-only runtime evidence; do not hand-edit them outside targeted repair tooling.
- Keep cognition at this folder level only; do not add docs per snapshot file.
- Preserve filename structure because resume/status tooling infers run identity from it.

## Architecture assumptions

- `src/loop/run-bootstrap.ts` and `src/loop/resume.ts` are the authoritative writers for this folder.
- Files here are durable evidence for run recovery and auditing, not canonical configuration inputs.

## Read before editing

- [`src/loop/run-bootstrap.ts`](../../src/loop/run-bootstrap.ts)
- [`src/loop/resume.ts`](../../src/loop/resume.ts)
- [`../POLARIS.md`](../POLARIS.md)

## Related routes

- `.polaris`
- `.polaris/runs`
- `.taskchain_artifacts/polaris-run`
