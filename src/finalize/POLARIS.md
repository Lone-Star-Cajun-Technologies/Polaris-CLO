# src/finalize

## Purpose

The finalize subsystem implements the atomic 13-step final delivery sequence for a Polaris cluster run. It is the only subsystem that pushes branches, opens PRs, and closes out Linear issues. It runs at session end when all children are Done and the user requests delivery.

## What belongs here

- `index.ts` — `polaris finalize run` orchestrator
- `steps/` — one file per delivery step; each exports a single named function
- `github.ts`, `linear.ts` — PR creation and Linear update helpers
- `run-report.ts`, `finalize.test.ts` — report generation and integration tests

## What does not belong here

- Session checkpoint logic — belongs in `src/loop/checkpoint.ts`
- Atlas map operations — belongs in `src/map/`
- Config loading — belongs in `src/config/`

## Editing rules

- The finalize sequence is fixed and ordered. Do not reorder steps or add delivery steps outside `steps/`.
- Each step file exports a single named function (`step<Name>`). Steps must not call each other directly — the orchestrator in `index.ts` sequences them.
- Tracker reconciliation runs before the final commit. Only validated cluster-state/result evidence may queue sync-out mutations, and any tracker conflict/failure must abort finalize.
- `stepCommit` must commit exactly: state + map + run-report. No other files.
- Remote delivery steps after the commit are skipped when `--skip-delivery` is passed or `--dry-run` is active. Enforce this in `runFinalize`, not in individual step files.
- `polaris finalize run` is manual/operator-triggered and performs delivery unless `--dry-run` or `--skip-delivery` is supplied.
- JSONL telemetry events (`pr-opened`, `run-complete`) are emitted by `polaris finalize` via step 10. Do not emit them elsewhere.
- `polaris finalize` is the only command that pushes to remote. No other subsystem may call `git push`.

## Route model

- Delivery is atomic: if any step fails, the session does not report completion.
- Tracker sync-out is atomic with finalize: unresolved reconciliation failures block delivery before the final commit.
- The PR is created as a draft (`prDraft: true` by default in config).
- `polaris finalize` reads `current-state.json` for cluster_id, branch, run_id, and completed_children — it does not re-read Linear for this information.
- Linear parent issue (cluster_id) is updated in step 11 after the PR URL is known.

## Read before editing

- `docs/spec/polaris-architecture-spec.md` — finalize's role in the loop/map/finalize triad
- `.polaris/skills/polaris-run/chain.md` — step 08 (final-delivery) invocation contract
- `src/loop/checkpoint.ts` — state schema that `runFinalize` reads

## Related routes

- `polaris.finalize` — all files in this directory
