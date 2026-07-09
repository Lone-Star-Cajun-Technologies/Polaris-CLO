# src/loop

## Purpose

The loop subsystem manages the session lifecycle for Polaris cluster runs. It handles checkpointing state between child executions, generating bootstrap packets for session resume, enforcing session boundaries (one child per session), and providing `run`, `dispatch`, `continue`, `resume`, `status`, and `abort` commands. It also ingests worker run-health symptoms and hands off to Medic when a run-health report requires diagnosis.

## What belongs here

- `parent.ts` — automated parent-loop orchestration (`polaris loop run`); integrates router, telemetry emission, run-health symptom ingestion, and Medic consult dispatch
- `dispatch.ts` — child claim and WorkerPacket emission (`polaris loop dispatch`); drives router decision and slot management
- `dispatch-state.ts` — worker dispatch state machine types and transition logic
- `worker-packet.ts` — WorkerPacket generation and immutability contract
- `orphan-recovery.ts` — orphan detection across 5 scenarios; emits `child-orphaned` events
- `ledger.ts` — append-only run ledger (`LedgerWriter`); emits `child-completed` and `cluster-complete` events
- `continue.ts` — state checkpoint, telemetry, bootstrap packet, one-child boundary (`polaris loop continue`)
- `resume.ts` — branch and state integrity verification before a new session
- `abort.ts` — blocker record and clean halt (`polaris loop abort`)
- `checkpoint.ts` — sole owner of `current-state.json` reads/writes
- `bootstrap-packet.ts` — self-contained bootstrap packet generation
- `router/` — Worker Router decision engine: eligibility, trust/cost ranking, slot management, fallback chain, and decision evidence
- `adapters/` — execution adapters for dispatching bootstrap packets (TerminalCli, AgentSubtask, Foreman dispatch)
- `index.ts`, `status.ts`, `*.test.ts` — command registration, status query, tests

## What does not belong here

- Atlas file operations — belongs in `src/map/`
- Final delivery steps (push, PR, Linear update) — belongs in `src/finalize/`
- Config loading — belongs in `src/config/`

## Editing rules

- `polaris loop continue` always halts after one child completes (STOP rule). Do not add CONTINUE paths that execute multiple children in a single session.
- `polaris loop continue` is mutating: it writes `current-state.json`, appends telemetry, runs canon checks, and writes a bootstrap packet after worker return.
- Sealed lifecycle dispatch validation may apply durable post-validation side effects for accepted results (for example cognition provenance archival), so keep those hooks deterministic and idempotent.
- Use `polaris loop status` for safe/read-only operator checks and smoke tests.
- State writes must use `checkpoint.ts` helpers — never write `current-state.json` directly with `fs`.
- The JSONL telemetry file is append-only. Never truncate or overwrite it.
- Bootstrap packets include enough context for a cold-start agent to resume without replaying JSONL history.
- `polaris loop abort` must set `status: blocked` and emit a `loop-aborted` JSONL event before exiting.
- The parent loop emits `child-completed` and `cluster-complete` ledger events via `LedgerWriter` after each successful child and at cluster completion. These are append-only durable records in the run ledger. Ledger event writes are gated by the `dryRun` flag: when `dryRun` is true, ledger events are not written; ledger writes occur only when `dryRun` is false.
- The post-dispatch budget-exhausted re-check only runs when `state.open_children.length > 0`. Once the final child completes, `open_children` is empty and the loop skips straight past the budget-exhausted halt to the next iteration's top-of-loop `nextChild === null` path, which always reaches cluster-complete and the QC repair-loop trigger. Do not remove this guard — without it, a budget equal to the cluster size halts with `budget-exhausted` and bypasses cluster-complete/QC entirely.
- The `child-complete` telemetry event includes `elapsed_seconds` (computed from `dispatch_record.dispatched_at`) and `commit_files` (files from the worker's last commit). `elapsed_seconds` is omitted when dispatch time is unavailable; `commit_files` may be null when the commit cannot be resolved.
- `writeStateAtomic` strips `body` from `open_children_meta` for all children except the immediate next child to reduce state file size. Body content is preserved in `.polaris/clusters/<id>/clusters.json` and is recoverable via `readBodyFromClusterSnapshot`. Do not rely on `body` being present in `open_children_meta` for non-next children at runtime.
- `BootstrapPacket.open_children` is `{ next_child: string | null, remaining_count: number }`, not a full array. Only the next child identity and remaining count are included; the full child list is not transmitted in bootstrap packets.
- A `bootstrap-context-size` JSONL event is emitted before each child dispatch. It records the byte size of the serialized state file and worker packet with an estimated token count (`Math.round(bytes / 4)`). This event is skipped in dry-run mode.

## Route model

- The session boundary is enforced by `context_budget.children_completed >= 1` in `current-state.json`.
- `polaris loop continue` reads `.polaris/session-type` and `current-state.json` to determine boundary behavior.
- Bootstrap packets are written to `.taskchain_artifacts/polaris-run/runs/<run-id>/`.
- Run IDs follow the format: `polaris-run-<slug>-<date>-<seq>` (e.g., `polaris-run-loop-boundary-2026-05-23-001`).

## Read before editing

- `docs/spec/polaris-architecture-spec.md` — full loop/map/finalize architecture
- `.polaris/skills/polaris-run/chain.md` — step traversal order, continuation rules, telemetry requirements
- `src/loop/checkpoint.ts` — state schema and read/write contract
- `smartdocs/specs/active/worker-router-architecture.md` — Worker Router architecture, slot-aware scheduling, and provider selection invariants
- `src/loop/router/engine.ts` — deterministic router decision engine
- `src/loop/router/types.ts` — WorkerRouterInput, WorkerRouterDecision, RouterRejectionReason types

## Architecture notes

- The Worker Router (`src/loop/router/`) is implemented and integrated into dispatch. `dispatch.ts` calls `decideWorkerRoute()` with router context (role, taskType, constraints, runtime slot state), validates the decision, and records `routerEvidence` in the dispatch record. Telemetry events (`provider-selected`, `provider-fallback-attempted`, `provider-exhausted`) are emitted from dispatch and parent.
- Slot-aware child scheduling lives in `src/runtime/scheduling/child-selector.ts`. It enforces `maxActiveWorkers` concurrency limits and tracks `slot_claims` per child. With `routerPolicy.defaultWorkerPool.maxActiveWorkers = 1` (the default), behavior is identical to the legacy single-worker loop.
- Router fallback (`pre_dispatch_failure`) is handled in execution adapters: the adapter returns `fallback_eligible: true` and `router_evidence`, and the caller may retry the next provider in the fallback chain. Once a worker emits `worker-acknowledged`, the child is bound and no further fallback is attempted.
- SOL scoring inputs are emitted from dispatch and parent as router telemetry; `src/autoresearch/score.ts` reads these events to compute `RouterOutcomesSummary`.

## QC relationship

- The loop owns child dispatch ordering and is not responsible for QC execution.
- Completed-cluster QC triggers after all children are complete and Closeout Librarian has produced documentation evidence.
- Child-level QC is opt-in and policy-gated; it runs after a single child completes and before the next child is dispatched.
- Run-health symptom ingestion happens after worker completion and before finalize/closeout: the parent loop appends worker symptoms into the run-health report, and if a report already requires Medic input it dispatches Medic for consult.
- QC results are durable artifacts written by `src/qc/` and consumed by finalize, cluster-state, and autoresearch; the loop does not parse provider output.

## QC repair loop relationship

- When `src/qc/orchestration.ts` compiles a repair packet manifest, the loop dispatches repair workers as governed children using `worker_role: repair` through `dispatch.ts` and the Worker Router.
- Repair workers are normal governed children. The loop's session boundary (one child per session), slot management, and STOP rule apply equally to repair workers.
- `src/qc/` owns repair round state and the compiled manifest. The loop owns worker dispatch and slot claims; it does not modify QC round state directly.
- After all repair workers in a round complete, the loop signals `src/qc/orchestration.ts` to trigger the post-repair QC rerun. The loop does not own the rerun decision.
- The bounded round limit (`maxRepairRounds`, default `2`) is enforced by `src/qc/orchestration.ts`. The loop does not need to track repair round counts.
- `open_children` and `completed_children` in `current-state.json` reflect repair workers just as they reflect any other child. The loop must not treat repair workers differently at the dispatch or continue boundary.
- See `smartdocs/specs/active/quality-control-architecture.md §8` for the full repair loop implementation contract.

## Related routes

- `polaris.loop` — all files in this directory
