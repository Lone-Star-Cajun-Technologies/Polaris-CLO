# src

## Purpose

The `src/` tree contains the Polaris application source: CLI entrypoints, runtime orchestration, config loading and validation, cognition/map/Smart Docs governance, graph extraction/query/governance, tracker adapters, finalization, and shared utilities.

## What belongs here

- Route folders such as `cli/`, `loop/`, `runtime/`, `config/`, `cognition/`, `map/`, `smartdocs-engine/`, `graph/`, `finalize/`, `tracker/`, and `agent-plugin/`
- Shared support modules such as `mcp/`, `types/`, `utils/`, `ignore/`, `cluster-state/`, and `skill-packet/`
- `medic/` — Medic chart ID generation and chart schema validation (chart creation tooling)
- `lint/` — Repository lint rules; currently enforces Navigation Before Retrieval doctrine on skill chain files
- `agent-plugin/` — Host-agnostic slash-command manifest, Claude Code shim generator, argument validation, help/error generation, and shim drift detection/sync

## What does not belong here

- Generated runtime artifacts under `.polaris/`
- Canonical Smart Docs content under `smartdocs/`
- Repo build outputs or caches that are not checked-in source

## Editing rules

- Keep route responsibilities isolated; prefer editing the owning subfolder over cross-route imports.
- Use the owning folder's POLARIS.md before changing code in that folder.
- Graph governance outputs live under `.polaris/graph/` and are runtime data, not source files.

## Architecture assumptions

- `src/` is the checked-in source root for the Polaris runtime.
- Cognition, map, Smart Docs, and graph subsystems are separate and documented with folder-level contracts.
- Route health and identity checks span `src/map/`, `src/cognition/`, and CLI command wiring; keep their public terms aligned.
- New config or governance surfaces must be reflected in the relevant subfolder docs.

## Read before editing

- `src/config/POLARIS.md`
- `src/cognition/POLARIS.md`
- `src/map/POLARIS.md`
- `src/graph/POLARIS.md`
- `src/smartdocs-engine/POLARIS.md`
- `src/SUMMARY.md`

## Related routes

- `src/*`
