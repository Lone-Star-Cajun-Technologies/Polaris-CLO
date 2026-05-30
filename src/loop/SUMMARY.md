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

## Relationships
- **Upstream**: `src/cli`, `src/config`
- **Downstream**: `src/finalize` (delivery), `src/map` (atlas update at step 01)
- **Peer**: `src/cognition` (called from `worker.ts` after child completes)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/spec/polaris-architecture-spec.md`
- `docs/spec/ephemeral-execution-architecture.md`
