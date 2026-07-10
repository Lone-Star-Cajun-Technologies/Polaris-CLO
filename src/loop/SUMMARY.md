# Summary: loop

## Purpose
Session lifecycle manager for Polaris cluster runs — orchestrates child dispatch, checkpointing, resume, abort, and run-health symptom ingestion.

## Key behaviors
- One child per session (STOP rule); enforced by `context_budget.children_completed >= 1` in `current-state.json`.
- `checkpoint.ts` is the sole owner of `current-state.json` reads/writes.
- `.polaris/clusters/<cluster-id>/cluster-state.json` is the live execution authority; `current-state.json` remains a compatibility/debug surface during migration.
- Bootstrap packets are self-contained: cold-start agents resume without replaying JSONL history.
- `.polaris/bootstrap/` is a derived sealed handoff surface, and telemetry remains append-only audit/debug output.
- JSONL telemetry ledger is append-only; truncation breaks the telemetry contract.
- The parent loop emits `child-completed` and `cluster-complete` events to the run ledger (via `LedgerWriter`) after each successful child and when all children complete. These are durable, queryable records distinct from JSONL telemetry.
- The post-dispatch budget-exhausted check is skipped once `open_children` is empty (final child completed), so a fully completed cluster reaches cluster-complete/QC repair-loop handling instead of halting with `budget-exhausted`.
- The `child-complete` JSONL telemetry event now includes `elapsed_seconds` (time from dispatch to completion) and `commit_files` (list of files in the worker's commit) when available.
- A `bootstrap-context-size` JSONL event is emitted before each child dispatch recording state file bytes, worker packet bytes, and estimated token counts; skipped in dry-run mode.
- `writeStateAtomic` slims `open_children_meta` by stripping `body` from all non-next children; bodies are preserved in `.polaris/clusters/<id>/clusters.json` and recoverable via `readBodyFromClusterSnapshot`.
- `BootstrapPacket.open_children` is `{next_child, remaining_count}` (not a full array); only the next child identity and count are transmitted.

## Relationships
- **Upstream**: `src/cli`, `src/config`
- **Downstream**: `src/finalize` (delivery), `src/map` (atlas update at step 01)
- **Peer**: `src/cognition` (called from `worker.ts` after child completes)

## Current State
The loop subsystem now includes the Worker Router (`src/loop/router/`). `dispatch.ts` calls `decideWorkerRoute()` to select a provider via deterministic eligibility, trust, and cost ranking; attaches `routerEvidence` to the dispatch record; and emits `provider-selected`, `provider-fallback-attempted`, and `provider-exhausted` telemetry events. Slot-aware child scheduling is in `src/runtime/scheduling/child-selector.ts`: it enforces `maxActiveWorkers` from `routerPolicy.defaultWorkerPool`, tracks `slot_claims`, and returns `rejected_children` with typed reasons. Adapter fallback (`pre_dispatch_failure`) is integrated in `TerminalCliAdapter` and `AgentSubtaskAdapter`; once a worker emits `worker-acknowledged` the child is bound and fallback stops. Router telemetry feeds `src/autoresearch/score.ts` via `summarizeRouterOutcomes()`. The loop now also ingests worker run-health symptoms into `.polaris/runs/<run-id>/run-health-report.json` and, when the report needs diagnosis, dispatches Medic consult before delivery. When QC is enabled, completed-cluster QC triggers `runQcRepairLoop()` from `src/qc/repair-loop.ts`; the loop's `dispatchRepairWorker` callback dispatches repair workers via the configured `ExecutionAdapter` directly, bypassing `polaris loop continue` and the Worker Router. The repair loop itself enforces `maxRepairRounds` and `repairDispatchTimeoutMs`. With all defaults (`max_concurrent = 1`, `allowCrossAgentFallback = false`), loop behavior is identical to the pre-router single-worker model.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `smartdocs/specs/active/polaris-implementation-plan.md`
- `smartdocs/architecture/ephemeral-execution-architecture.md`
- `smartdocs/specs/active/worker-router-architecture.md`
