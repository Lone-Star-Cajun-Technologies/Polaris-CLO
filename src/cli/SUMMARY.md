# Summary: cli

## Purpose
Command wiring for the `polaris` binary and command-family entrypoints.

## Core Concepts
- Commander.js command tree is assembled in `index.ts`.
- Command implementations live in subsystem routes; this folder only delegates.
- `analyze spec` and `run spec` flow through `SpecAdapter` to create/load local graphs.

## Architectural Role
Defines operator-facing invocation surfaces while keeping runtime logic elsewhere.

## Key Constraints
- Do not embed subsystem business logic in CLI wiring.
- Missing/invalid subcommands must fail with actionable help.
- Version reporting must come from package metadata via `getVersion()`.

## Important Relationships
- **Downstream:** `src/loop`, `src/finalize`, `src/map`, `src/config`, `src/smartdocs-engine`

## Current State
Includes dedicated surfaces for spec-driven flows and closeout librarian packet dispatch alongside loop/finalize/map commands.

## Known Drift
None identified in this reconciliation pass.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
