# src/finalize

## Purpose

The finalize subsystem implements the atomic 12-step final delivery sequence for a Polaris cluster run. It is the only subsystem that pushes branches, opens PRs, and closes out Linear issues. It runs at session end when all children are Done and the user requests delivery.

## What belongs here

- `index.ts` — `polaris finalize run` orchestrator
- `steps/` — one file per step (01–12); each exports a single named function
- `github.ts`, `linear.ts` — PR creation and Linear update helpers
- `run-report.ts`, `finalize.test.ts` — report generation and integration tests

## What does not belong here

- Session checkpoint logic — belongs in `src/loop/checkpoint.ts`
- Atlas map operations — belongs in `src/map/`
- Config loading — belongs in `src/config/`

## Editing rules

- The 12-step sequence is fixed and ordered. Do not reorder steps or add steps outside `steps/`.
- Each step file exports a single named function (`step<Name>`). Steps must not call each other directly — the orchestrator in `index.ts` sequences them.
- `stepCommit` (step 06) must commit exactly: state + map + run-report. No other files.
- Steps 7–12 are skipped when `--skip-delivery` is passed or `--dry-run` is active. Enforce this in `runFinalize`, not in individual step files.
- `polaris finalize run` is manual/operator-triggered and performs delivery unless `--dry-run` or `--skip-delivery` is supplied.
- JSONL telemetry events (`pr-opened`, `run-complete`) are emitted by `polaris finalize` via step 10. Do not emit them elsewhere.
- `polaris finalize` is the only command that pushes to remote. No other subsystem may call `git push`.

## Route model

- Delivery is atomic: if any step fails, the session does not report completion.
- The PR is created as a draft (`prDraft: true` by default in config).
- `polaris finalize` reads `current-state.json` for cluster_id, branch, run_id, and completed_children — it does not re-read Linear for this information.
- Linear parent issue (cluster_id) is updated in step 11 after the PR URL is known.

## Read before editing

- `docs/spec/polaris-architecture-spec.md` — finalize's role in the loop/map/finalize triad
- `.codex/skills/polaris-run/chain.md` — step 08 (final-delivery) invocation contract
- `src/loop/checkpoint.ts` — state schema that `runFinalize` reads

## Related routes

- `polaris.finalize` — all files in this directory
