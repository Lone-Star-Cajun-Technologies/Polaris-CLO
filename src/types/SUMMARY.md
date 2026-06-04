# Summary: types

## Purpose
Holds shared runtime type contracts consumed across Polaris subsystems.

## Core Concepts
- `CurrentState`/audit types model persisted run lifecycle state.
- `WorkContract` normalizes work intake across tracker-backed and local sources.
- Integration declaration files support typed external adapter/tool boundaries.

## Architectural Role
Prevents type drift between loop, finalize, tracker, and CLI surfaces.

## Key Constraints
- Changes here can break multiple routes; keep contracts backward compatible where feasible.
- Core contracts should not encode tracker-specific assumptions.
- Keep declarations focused on structure; behavior belongs in implementation routes.

## Important Relationships
- **Downstream:** `src/loop`, `src/finalize`, `src/tracker`, `src/cli`

## Current State
Includes runtime state contracts and a two-source work contract (`linear` and `local`) for tracker-backed and trackerless execution paths.

## Known Drift
None identified in this reconciliation pass.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
