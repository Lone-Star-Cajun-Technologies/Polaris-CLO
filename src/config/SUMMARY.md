# Summary: config

## Purpose
Loads, merges, and validates `PolarisConfig` for all runtime subsystems.

## Core Concepts
- `DEFAULT_CONFIG` is the authoritative baseline.
- User config is deep-merged over defaults.
- Schema/types must stay aligned with defaults and validator behavior.
- Tracker adapter selection is explicit (`linear`, `mcp-bridge`, `local`) and may be omitted.

## Architectural Role
Provides one normalized config contract consumed by loop, finalize, map, and tracker subsystems.

## Key Constraints
- Defaults must always be valid against schema constraints.
- New config fields require synchronized updates across schema, TS types, and defaults.
- Callers should use `loadConfig()` rather than raw file reads.

## Important Relationships
- **Upstream:** `polaris.config.json`
- **Downstream:** `src/loop`, `src/finalize`, `src/tracker`, `src/skill-packet`

## Current State
Config surfaces support trackerless/local execution and remote tracker adapters without requiring Linear as a hard dependency.

## Known Drift
None identified in this reconciliation pass.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
