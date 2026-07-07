# Summary: scheduling

## Purpose
Slot-aware child selection for the Polaris parent loop. Evaluates open children against slot limits, dependency blocks, and router eligibility to return the next schedulable child.

## Core Concepts
- `selectNextChild()` is a pure function: given open children, a `decide_route` callback, `max_concurrent`, and existing slot claims, it returns `selected_child`, updated `slot_claims`, and `rejected_children` with typed reasons.
- Slot claims are lease records (`child_id` + `claimed_at`) that enforce concurrency limits. `pruneExpiredClaims()` from `src/cluster-state/store.ts` must run before selection to ensure accurate counts.
- Children are rejected with `"blocked-dependency"` or `"router-ineligible"`; neither silently skips a child.
- With `max_concurrent = 1`, behavior is identical to the legacy sequential scheduler.

## Architectural Role
This folder sits between the parent loop (`src/loop/parent.ts`) and the router engine (`src/loop/router/`). The parent calls `selectNextChild()` with a `decide_route` callback that wraps `decideWorkerRoute()`, keeping scheduling testable without a full loop setup.

## Key Constraints
- `selectNextChild()` must be deterministic and side-effect-free. No disk I/O, no telemetry.
- `slot_claims.length` must never exceed `max_concurrent` on return.
- Do not replicate router logic here; call the injected `decide_route` callback instead.

## Important Relationships
- **Upstream**: `src/loop/parent.ts` (caller)
- **Peer**: `src/loop/router/` (provides `decide_route` callback), `src/cluster-state/` (provides `pruneExpiredClaims`)

## Current State
`child-selector.ts` implements `selectNextChild()` with full slot-aware logic and typed rejection reasons. Integrated into the parent loop for multi-worker-ready dispatch; default `maxActiveWorkers = 1` preserves single-worker behavior.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `smartdocs/specs/active/worker-router-architecture.md`
- `src/loop/router/types.ts`
