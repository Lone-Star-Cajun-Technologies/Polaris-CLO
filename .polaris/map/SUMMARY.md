# Summary: map

## Purpose
Sidecar atlas output root for repository routing metadata.

## Key behaviors
- Stores indexed routes, needs-review entries, summary metrics, and exemptions.
- The data is derived and regenerable, but other runtime subsystems depend on its current shape.
- Folder-level cognition explains the contract without treating the JSON payloads as source files.

## Relationships
- **Written by**: `src/map`
- **Read by**: `src/loop`, `src/finalize`, `src/cognition`, `src/smartdocs-engine`

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `../../src/map/POLARIS.md`
