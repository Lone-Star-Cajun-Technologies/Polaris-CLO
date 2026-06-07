# smartdocs

## Purpose

The SmartDocs vault root is the canonical cognition origin for repository documentation. Vault config lives in `.obsidian/`; all canonical content lives directly under `smartdocs/`.

## What belongs here

- `.obsidian/` — vault configuration only
- `architecture/`, `doctrine/`, `specs/`, `integrations/`, `audits/`, `decisions/` — canonical content domains
- `medic/` — Medic role artifacts; `medic/charts/` stores Medic diagnostic charts (CHART-YYYY-MM-DD-NNN)
- `raw/` — ingest staging area
- `runtime/` — generated runtime output (excluded from cognition)

## What does not belong here

- A `docs/` subdirectory nesting layer (removed; content is now at canonical root)
- Generated runtime artifacts at vault root
- Export dumps or transient validation output

## Editing rules

- Keep root cognition stable and minimal.
- Prefer route-local cognition in deeper directories when the topic is specific.
