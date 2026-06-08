# src/finalize

## Purpose

The finalize subsystem implements the atomic 13-step final delivery sequence for a Polaris cluster run. It is the only subsystem that pushes branches, opens PRs, and closes out Linear issues. It runs at session end when all children are Done and the user requests delivery.

## What belongs here

- `index.ts` — `polaris finalize run` orchestrator
- `artifact-policy.ts` — source-of-truth classifier for promoted Polaris artifacts versus workspace scratch
- `steps/` — one file per delivery step; each exports a single named function
- `github.ts`, `linear.ts` — PR creation and Linear update helpers
- `run-report.ts`, `finalize.test.ts`, `artifact-policy.test.ts` — report generation and finalize policy tests

## What does not belong here

- Session checkpoint logic — belongs in `src/loop/checkpoint.ts`
- Atlas map operations — belongs in `src/map/`
- Config loading — belongs in `src/config/`

## Editing rules

- The finalize sequence is fixed and ordered. Do not reorder steps or add delivery steps outside `steps/`.
- Each step file exports a single named function (`step<Name>`). Steps must not call each other directly — the orchestrator in `index.ts` sequences them.
- Tracker reconciliation runs before the final commit. Only validated cluster-state/result evidence may queue sync-out mutations, and any tracker conflict/failure must abort finalize.
- Treat `artifact-policy.ts` as the single source of truth for Polaris-owned artifact promotion and commit-hygiene rules; do not duplicate `.polaris/`/`.taskchain_artifacts/` path checks in individual step files.
- `stepCommit` must only promote durable Polaris evidence plus intentional source/doc changes; live workspace scratch stays out of delivery commits.
- Remote delivery steps after the commit are skipped when `--skip-delivery` is passed or `--dry-run` is active. Enforce this in `runFinalize`, not in individual step files.
- The closeout-librarian gate must pass before `polaris finalize run` may create or publish delivery artifacts. The canonical terminal cluster state lives at `.polaris/clusters/<cluster-id>/state.json`.
- `polaris finalize run` is manual/operator-triggered and performs delivery unless `--dry-run` or `--skip-delivery` is supplied.
- JSONL telemetry events (`pr-opened`, `run-complete`) are emitted by `polaris finalize` via step 10. Do not emit them elsewhere.
- `polaris finalize` is the only command that pushes to remote. No other subsystem may call `git push`.

## Route model

- Delivery is atomic: if any step fails, the session does not report completion.
- Tracker sync-out is atomic with finalize: unresolved reconciliation failures block delivery before the final commit.
- The PR is created as a draft (`prDraft: true` by default in config).
- `polaris finalize` reads the canonical cluster state for cluster_id, branch, run_id, and completed_children — it does not re-read Linear for this information.
- Linear parent issue (cluster_id) is updated in step 11 after the PR URL is known.

## Read before editing

- `smartdocs/specs/active/polaris-artifact-promotion-commit-hygiene-policy.md` — durable artifact promotion and commit-hygiene contract
- `docs/spec/polaris-architecture-spec.md` — finalize's role in the loop/map/finalize triad
- `.polaris/skills/polaris-run/chain.md` — step 08 (final-delivery) invocation contract
- `src/loop/checkpoint.ts` — state schema that `runFinalize` reads

## Related routes

- `polaris.finalize` — all files in this directory
