# Summary: runtime

## Purpose
Cross-cutting execution support layer for the Polaris loop: context window budget tracking, execution state types, session status reporting, and slot-aware child scheduling.

## Core Concepts
- `execution-window.ts` tracks token/budget signals without writing state or telemetry.
- `state.ts` provides shared runtime state types used by loop, scheduling, and audit.
- `scheduling/child-selector.ts` is a pure, side-effect-free function that enforces slot limits and router eligibility.
- `scheduling/` is called from `src/loop/parent.ts` with an injected `decide_route` callback for testability.

## Architectural Role
This folder is the infrastructure layer between the orchestration loop (`src/loop/`) and the lower-level persistence stores (`src/cluster-state/`). It does not own loop dispatch or cluster state writes.

## Key Constraints
- Keep scheduling logic pure and side-effect-free.
- Do not add loop-specific business logic to shared runtime types.

## Important Relationships
- **Upstream**: `src/loop/parent.ts` (calls scheduling)
- **Peer**: `src/loop/router/` (provides routing input), `src/cluster-state/` (provides slot claim management)

## Current State
`scheduling/child-selector.ts` is implemented and integrated. `execution-window.ts`, `state.ts`, `status.ts`, `checkpoint.ts` are stable. `audit/`, `continuation/`, and `verification/` subfolders are present.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/runtime/scheduling/POLARIS.md`
