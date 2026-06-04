# Summary: steps

## Purpose
Discrete implementation units for finalize step side effects.

## Core Concepts
- Each numbered file maps to a delivery stage in `runFinalize`.
- Steps are intentionally small and side-effect scoped.
- Orchestrator-level gates (librarian gate, delivery integrity, skip flags) live outside this folder.

## Architectural Role
Provides composable step primitives consumed by finalize orchestration.

## Key Constraints
- Keep step contracts stable: function names and numbering are externally referenced.
- Do not move tracker/librarian gate logic into step files unless the orchestrator contract changes.
- Steps should depend on passed-in state rather than reading global mutable context.

## Important Relationships
- **Upstream:** `src/finalize/index.ts`
- **Downstream:** git/GitHub/telemetry/Linear side effects

## Current State
Implements map validation, report generation, commit/push/PR/state update, telemetry append, tracker update, and archive steps.

## Known Drift
None identified in this reconciliation pass.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
