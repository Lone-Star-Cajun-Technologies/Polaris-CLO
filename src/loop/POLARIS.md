# src/loop

## Purpose

The loop subsystem manages the session lifecycle for Polaris cluster runs. It handles checkpointing state between child executions, generating bootstrap packets for session resume, enforcing session boundaries (one child per session), and providing `run`, `dispatch`, `continue`, `resume`, `status`, and `abort` commands.

## What belongs here

- `parent.ts` — automated parent-loop orchestration (`polaris loop run`)
- `dispatch.ts` — child claim and WorkerPacket emission (`polaris loop dispatch`)
- `continue.ts` — state checkpoint, telemetry, bootstrap packet, one-child boundary (`polaris loop continue`)
- `resume.ts` — branch and state integrity verification before a new session
- `abort.ts` — blocker record and clean halt (`polaris loop abort`)
- `checkpoint.ts` — sole owner of `current-state.json` reads/writes
- `bootstrap-packet.ts` — self-contained bootstrap packet generation
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
- The parent loop emits `child-completed` and `cluster-complete` ledger events via `LedgerWriter` after each successful child and at cluster completion. These are append-only durable records in the run ledger and must not be gated by dry-run only when `dryRun` is false.
- The `child-complete` telemetry event includes `elapsed_seconds` (computed from `dispatch_record.dispatched_at`) and `commit_files` (files from the worker's last commit). `elapsed_seconds` is omitted when dispatch time is unavailable; `commit_files` may be null when the commit cannot be resolved.

## Route model

- The session boundary is enforced by `context_budget.children_completed >= 1` in `current-state.json`.
- `polaris loop continue` reads `.polaris/session-type` and `current-state.json` to determine boundary behavior.
- Bootstrap packets are written to `.taskchain_artifacts/polaris-run/runs/<run-id>/`.
- Run IDs follow the format: `polaris-run-<slug>-<date>-<seq>` (e.g., `polaris-run-loop-boundary-2026-05-23-001`).

## Read before editing

- `docs/spec/polaris-architecture-spec.md` — full loop/map/finalize architecture
- `.polaris/skills/polaris-run/chain.md` — step traversal order, continuation rules, telemetry requirements
- `src/loop/checkpoint.ts` — state schema and read/write contract

## Related routes

- `polaris.loop` — all files in this directory
