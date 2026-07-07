# runtime

## Purpose

The runtime folder provides cross-cutting execution support for the Polaris loop: context window budget tracking, execution state helpers, session status reporting, and slot-aware child scheduling. It does not own the loop orchestration (that is `src/loop/`) but provides the infrastructure layer the loop depends on.

**Domain:** runtime
**Route:** src/runtime

## What belongs here

- `checkpoint.ts` — runtime checkpoint helpers (distinct from `src/loop/checkpoint.ts`; provides shared state helpers for runtime layers)
- `execution-window.ts` — context window budget tracking; tracks token counts and reports budget exhaustion signals
- `state.ts` — runtime state types shared across loop, scheduling, and audit subsystems
- `status.ts` — session status reporting utilities
- `scheduling/` — slot-aware child scheduling (`child-selector.ts`); enforces `max_concurrent` limits via router decision integration
- `audit/`, `continuation/`, `verification/` — audit, continuation, and verification subsystems

## What does not belong here

- Cluster-level state persistence — belongs in `src/cluster-state/`
- Loop orchestration (dispatch, parent, checkpoint file I/O) — belongs in `src/loop/`
- Router decision logic — belongs in `src/loop/router/`

## Editing rules

- `execution-window.ts` tracks budget signals only; it must not emit telemetry or write state directly.
- `scheduling/child-selector.ts` is a pure function; keep it side-effect-free (no disk reads/writes, no telemetry).
- Do not add cross-concerns to this folder that are specific to a single subsystem.

## Architecture assumptions

- `scheduling/child-selector.ts` is called from `src/loop/parent.ts` with router context injected via a callback so it can be tested independently.
- Runtime types in `state.ts` are shared; changes here may affect loop, scheduling, and audit simultaneously.

## Read before editing

- `src/loop/POLARIS.md`
- `src/runtime/scheduling/POLARIS.md`
- `src/cluster-state/POLARIS.md`

## Related routes

- `src/loop/` — primary consumer of runtime utilities
- `src/cluster-state/` — owns cluster state persistence
- `src/loop/router/` — provides routing decisions consumed by scheduling
