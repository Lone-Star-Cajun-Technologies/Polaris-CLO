# Summary: src

## Purpose
Core Polaris runtime code for orchestration, execution, tracker integration, and delivery.

## Core Concepts
- `LocalGraph` is the canonical work graph abstraction.
- The loop subsystem owns dispatch/checkpoint/resume boundaries.
- The finalize subsystem owns delivery, including the closeout-librarian gate.
- Tracker adapters are pluggable; runtime logic remains adapter-agnostic.

## Architectural Role
Implements the executable engine used by `polaris` CLI commands.

## Key Constraints
- Source mutation must happen in worker scope, not foreman scope.
- Runtime state files are controlled by checkpoint/cluster-state stores.
- Finalize must block when librarian gating or delivery-integrity checks fail.

## Important Relationships
- **Upstream:** repo config (`polaris.config.json`), cluster artifacts in `.polaris/`
- **Downstream:** GitHub/Linear side effects through finalize + tracker adapters

## Current State
Tracker-aware and trackerless flows are both supported; finalize now enforces a closeout-librarian result gate before remote delivery.

## Known Drift
None identified in this reconciliation pass.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/spec/polaris-architecture-spec.md`
