# docs

## Purpose

Pre-canonical specification and planning documents for Polaris. This folder holds specs, architecture sketches, validation plans, and implementation plans that have not yet been ingested into the Smart Docs canonical authority structure (`smartdocs/docs/`).

## What belongs here

- `spec/` — architecture specs, validation plans, dispatch contracts, run-ledger spec, compact contracts, issue hierarchy doctrine

## What does not belong here

- Promoted doctrine or active specs — those belong in `smartdocs/docs/doctrine/active/` and `smartdocs/docs/specs/active/` after ingest.
- Runtime artifacts, telemetry, or state files.

## Editing rules

- Files here are pre-canonical. They inform design but do not govern runtime behavior until promoted via `polaris docs ingest`.
- Do not add operational stop-rules or behavioral imperatives here — those belong in route-local `POLARIS.md` files or promoted doctrine.

## Route model

- `docs/spec/` files are candidates for `polaris docs ingest` into `smartdocs/docs/`.
- Until promoted, these docs are informational only and do not override route-local cognition.

## Related routes

- `smartdocs/docs/` — canonical authority structure for promoted docs
- `src/smartdocs-engine` — ingest pipeline that promotes files from here
