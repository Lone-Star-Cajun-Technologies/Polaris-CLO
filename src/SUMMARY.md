# Summary: src

## Purpose
Application source root for Polaris. The tree contains command entrypoints, loop/runtime orchestration, config loading and validation, cognition/map/Smart Docs governance, graph governance, finalization, tracker adapters, and shared utilities.

## Core Concepts
- Folder-local guidance lives beside implementation in `POLARIS.md`.
- Cognition and map are read-only analysis layers; they report signals, not writes.
- Smart Docs governs canonical documentation under `smartdocs/`.
- Graph route manages extraction/resolution/query/store behavior and governance outputs under `.polaris/graph/`.
- Config changes must flow through `src/config/` and the JSON schema/validator.

## Architectural Role
`src/` is the implementation boundary for the product. The subfolders are intentionally split by concern so workers can edit one subsystem without reinterpreting the rest of the runtime.

## Key Constraints
- Avoid cross-route coupling; keep shared contracts in types or dedicated adapters.
- Do not write runtime outputs into source folders.
- Graph artifacts under `.polaris/graph/` are generated data and excluded from atlas validation and Smart Docs ingest.
- Route docs should describe current behavior, not history.

## Important Relationships
- `src/loop/` coordinates child execution and invokes cognition/map validation after children complete.
- `src/config/` defines the config surface consumed by all other routes.
- `src/cognition/` and `src/map/` provide read-only detection signals for documentation and atlas maintenance.
- `src/smartdocs-engine/` ingests/promotes docs and maintains canonical authority structure.
- `src/graph/` builds graph artifacts, resolves edges, and serves query helpers for CLI consumers.

## Current State
The tree includes graph extraction/resolution/query/store modules plus adapter selection, capability reporting, governance controls, and config support for `graph.outputPath` and `graph.invalidationTriggers`. Graph builds now degrade at file level for unsupported languages and surface coverage reporting. Cognition and atlas validation treat `.polaris/graph/` as generated runtime output.

## Known Drift
Draft markers remain in some top-level folder docs when a subroute has not yet been fully reconciled.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/config/POLARIS.md`
- `src/cognition/POLARIS.md`
- `src/map/POLARIS.md`
- `src/graph/POLARIS.md`
- `src/smartdocs-engine/POLARIS.md`
