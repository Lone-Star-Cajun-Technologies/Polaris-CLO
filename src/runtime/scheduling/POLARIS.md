# scheduling

## Purpose

The scheduling subfolder implements slot-aware child selection for the Polaris parent loop. It evaluates the set of open children against slot constraints, dependency blocks, and router eligibility, then returns the next schedulable child and the updated slot claim set.

**Domain:** runtime
**Route:** src/runtime

## What belongs here

- `child-selector.ts` — `selectNextChild()`: takes open children, a router `decide_route` callback, `max_concurrent` slot limit, and existing slot claims; returns `selected_child`, `slot_claims`, and `rejected_children` with typed rejection reasons

## What does not belong here

- Router decision logic — belongs in `src/loop/router/engine.ts`
- State persistence — belongs in `src/cluster-state/store.ts` or `src/loop/checkpoint.ts`
- Parent loop orchestration — belongs in `src/loop/parent.ts`

## Editing rules

- `selectNextChild()` must be deterministic and pure: given the same inputs, it must return the same output. Do not read from disk or emit telemetry inside this function.
- Slot claim pruning (`pruneExpiredClaims` from `src/cluster-state/store.ts`) must run before `selectNextChild()` so the slot count is accurate.
- Children blocked by dependency or router ineligibility are recorded in `rejected_children` with the typed reason (`"blocked-dependency"` or `"router-ineligible"`). Do not silently skip them.
- Do not allow `slot_claims.length` to exceed `max_concurrent`; the function must return `selected_child: null` when the pool is full.

## Architecture assumptions

- `WorkerRouterDecision` is produced by `decideWorkerRoute()` from `src/loop/router/engine.ts` via the injected `decide_route` callback. This keeps scheduling testable without a full router setup.
- Slot claims use `child_id` and `claimed_at` for expiry tracking; expiry handling is delegated to `pruneExpiredClaims`.
- With `max_concurrent = 1` (the default), `selectNextChild()` behaves exactly like the legacy sequential scheduler: it selects the first unblocked, router-eligible child.

## Read before editing

- [POLARIS.md](../POLARIS.md)
- `src/loop/router/types.ts` — `WorkerRouterDecision`, `RouterRejectionReason`
- `src/cluster-state/store.ts` — `pruneExpiredClaims`, `SlotClaim` shape
- `smartdocs/specs/active/worker-router-architecture.md` — slot pool invariants and scheduler boundaries

## Related routes

- `src/loop/` — consumes `selectNextChild()` from `parent.ts`
- `src/loop/router/` — provides the `decide_route` callback
- `src/cluster-state/` — provides claim pruning utilities
