# Summary: loop

## Purpose
Session lifecycle manager for Polaris cluster runs — orchestrates child dispatch, checkpointing, resume, and abort.

## Key behaviors
- One child per session (STOP rule); enforced by `context_budget.children_completed >= 1` in `current-state.json`.
- `checkpoint.ts` is the sole owner of `current-state.json` reads/writes.
- `.polaris/clusters/<cluster-id>/cluster-state.json` is the live execution authority; `current-state.json` remains a compatibility/debug surface during migration.
- Bootstrap packets are self-contained: cold-start agents resume without replaying JSONL history.
- `.polaris/bootstrap/` is a derived sealed handoff surface, and telemetry remains append-only audit/debug output.
- JSONL telemetry ledger is append-only; truncation breaks the telemetry contract.
- The parent loop emits `child-completed` and `cluster-complete` events to the run ledger (via `LedgerWriter`) after each successful child and when all children complete. These are durable, queryable records distinct from JSONL telemetry.
- When the parent loop reaches `cluster-complete`, it writes the canonical terminal cluster state to `.polaris/clusters/<cluster-id>/state.json`.
- The `child-complete` JSONL telemetry event now includes `elapsed_seconds` (time from dispatch to completion) and `commit_files` (list of files in the worker's commit) when available.
- `budget-exhausted` is a terminal halt distinct from `cluster-complete`; it records that the session cap stopped the run before the remaining state machine could finish.

## Relationships
- **Upstream**: `src/cli`, `src/config`
- **Downstream**: `src/finalize` (delivery), `src/map` (atlas update at step 01)
- **Peer**: `src/cognition` (called from `worker.ts` after child completes)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/spec/polaris-architecture-spec.md`
- `docs/spec/ephemeral-execution-architecture.md`
