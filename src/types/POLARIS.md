# types

## Purpose

Shared TypeScript contracts used across runtime subsystems for state, work intake normalization, and generated tool declarations.

**Domain:** types
**Route:** src/types
**Taskchain:** polaris-types

## What belongs here

- `runtime-state.ts` — current-state and audit event contracts
- `work-contract.ts` — normalized tracker/spec work contract types
- `linear.ts` / `tool-server-linear.d.ts` — generated integration type declarations

## What does not belong here

- Runtime business logic or adapter implementations
- Domain-local types that are only consumed in one folder
- JSON schema source-of-truth definitions (`src/config/schema.json`)

## Editing rules

- Keep shared types stable and additive when possible; avoid breaking cross-route consumers.
- Preserve tracker-agnostic naming in core contracts (`WorkContract`, `WorkSource`).
- When changing shared contracts, update dependent docs/tests in the same change set.

## Architecture assumptions

- Runtime state persists through `current-state.json` with compatibility fields.
- Work intake normalizes heterogeneous sources into `WorkContract`.
- Type declarations here are consumed by both loop/finalize orchestration and adapters.

## Read before editing

<!-- Links to canonical sources (doctrine, specs). -->

## Related routes

- `polaris.types` (this route)
- `polaris.loop`, `polaris.finalize`, `polaris.tracker` (primary consumers)
