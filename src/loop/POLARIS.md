# src/loop

## Purpose

The loop subsystem manages the session lifecycle for Polaris cluster runs. It handles checkpointing state between child executions, generating bootstrap packets for session resume, enforcing session boundaries (one child per session), and providing `run`, `dispatch`, `continue`, `resume`, `status`, and `abort` commands.

## What belongs here

- `index.ts` — `polaris loop` command registration
- `parent.ts` — `polaris loop run`: automated parent-loop orchestration for an IMPLEMENT cluster
- `dispatch.ts` — `polaris loop dispatch`: claim one open child and emit a compiled WorkerPacket
- `continue.ts` — `polaris loop continue`: checkpoint state, emit JSONL event, generate bootstrap packet, enforce one-child-per-session boundary
- `resume.ts` — `polaris loop resume`: verify branch and state integrity before a new session begins
- `status.ts` — `polaris loop status`: print current run state summary
- `abort.ts` — `polaris loop abort`: record a blocker, set status to blocked, halt cleanly
- `checkpoint.ts` — shared state read/write utilities (`readState`, `writeState`)
- `bootstrap-packet.ts` — bootstrap packet generation logic
- `*.test.ts` — unit tests for loop commands

## What does not belong here

- Atlas file operations — belongs in `src/map/`
- Final delivery steps (push, PR, Linear update) — belongs in `src/finalize/`
- Config loading — belongs in `src/config/`

## Editing rules

- `polaris loop continue` always halts after one child completes (STOP rule). Do not add CONTINUE paths that execute multiple children in a single session.
- `polaris loop continue` is mutating: it writes `current-state.json`, appends telemetry, may update the atlas map, runs canon checks, and writes a bootstrap packet after worker return.
- Use `polaris loop status` for safe/read-only operator checks and smoke tests.
- State writes must use `checkpoint.ts` helpers — never write `current-state.json` directly with `fs`.
- The JSONL telemetry file is append-only. Never truncate or overwrite it.
- Bootstrap packets include enough context for a cold-start agent to resume without replaying JSONL history.
- `polaris loop abort` must set `status: blocked` and emit a `loop-aborted` JSONL event before exiting.

## Architecture assumptions

- The session boundary is enforced by `context_budget.children_completed >= 1` in `current-state.json`.
- `polaris loop continue` reads `.polaris/session-type` and `current-state.json` to determine boundary behavior.
- Bootstrap packets are written to `.taskchain_artifacts/polaris-run/runs/<run-id>/`.
- Run IDs follow the format: `polaris-run-<slug>-<date>-<seq>` (e.g., `polaris-run-loop-boundary-2026-05-23-001`).

## Read before editing

- `docs/spec/polaris-architecture-spec.md` — full loop/map/finalize architecture
- `.codex/skills/polaris-run/chain.md` — step traversal order, continuation rules, telemetry requirements
- `src/loop/checkpoint.ts` — state schema and read/write contract

## Related routes

- `polaris.loop` — all files in this directory
