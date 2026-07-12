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
- `polaris finalize run` is manual/operator-triggered and performs delivery unless `--dry-run` or `--skip-delivery` is supplied.
- JSONL telemetry events (`pr-opened`, `run-complete`) are emitted by `polaris finalize` via step 10. Do not emit them elsewhere.
- `polaris finalize` is the only command that pushes to remote. No other subsystem may call `git push`.

## Route model

- Delivery is atomic: if any step fails, the session does not report completion.
- Tracker sync-out is atomic with finalize: unresolved reconciliation failures block delivery before the final commit.
- The PR is created as a draft (`prDraft: true` by default in config).
- `polaris finalize` reads `current-state.json` for cluster_id, branch, run_id, and completed_children — it does not re-read Linear for this information.
- Linear parent issue (cluster_id) is updated in step 11 after the PR URL is known.

## Architecture assumptions

- Finalize is the only delivery path that touches remote Git, PRs, and tracker closeout.
- The completed-cluster QC repair loop runs in-band before PR creation when `qc.enabled` is true and `qc.repairRouting` is `route` or `follow-up`.
- The Closeout Librarian and run-health Medic gates are independent prerequisites that run before finalize commits or delivers.

## Read before editing

- `smartdocs/specs/active/polaris-artifact-promotion-commit-hygiene-policy.md` — durable artifact promotion and commit-hygiene contract
- `smartdocs/specs/active/polaris-implementation-plan.md` — finalize's role in the loop/map/finalize triad
- `.polaris/skills/polaris-run/chain.md` — step 08 (final-delivery) invocation contract
- `src/loop/checkpoint.ts` — state schema that `runFinalize` reads

## QC relationship

- Finalize owns PR readiness and must consult cluster QC artifacts and policy before remote delivery.
- QC blocking findings are resolved before PR creation or delivery is aborted.
- QC artifacts follow `artifact-policy.ts` promotion rules; raw provider scratch stays out of delivery commits.
- PR-level QC triggers run after the PR is created; completed-cluster QC triggers run before the PR is created.

## Run-health Medic gate

- `validateMedicGate()` (Step 5.11, after the authoritative completed-child cross-check and before tracker reconciliation) blocks finalize when `.polaris/runs/<run-id>/run-health-report.json` exists and has no Medic decision (`medic_consult.status "resolved"` or `"bypassed"`) and no explicit `policy_bypass`.
- The gate runs before the final commit, push, PR creation, and tracker update. It does not replace or weaken the QC repair-loop or Closeout Librarian gates.
- A policy bypass requires `finalize.medic.bypassPolicy: "cli"` in `polaris.config.json` and the operator to pass `--bypass-medic "<reason>"`. The bypass writes auditable `policy_bypass` metadata into the run-health report.
- Absence of a run-health report means no symptoms were recorded; the gate passes without action.

## QC repair loop relationship

- `runCompletedClusterQcWithRepair()` (Step 5.8) runs the completed-cluster QC trigger and, for any non-`pass` result under active repair routing (`route` or `follow-up`), delegates directly to `runQcRepairLoop()`. It does not short-circuit `follow-up` results or implement bespoke `operator-review` handling inside finalize.
- Before `validateQcRepairLoopGate()` (Step 5.9) blocks finalize, `runCompletedClusterQcWithRepair()` calls `appendRepairLoopOutcomeSymptom()` and `appendQcEscalationSymptoms()` on the repair-loop result (mirroring the parent loop). This ensures untrusted outcomes (`all-providers-failed`, `max-rounds`, `medic-referral`) and any surviving post-repair findings are escalated to the run-health report.
- `runQcRepairLoop()` owns repair packet compilation, `operator-review` filtering, worker-dispatch timeout bounding, telemetry checkpointing, and terminal outcome selection. Only `repair-worker`-routed packets are passed to the finalize `dispatchRepairWorker` callback; `operator-review` packets resolve directly to the `operator-review` terminal outcome without worker dispatch.
- The finalize `repairDispatcher` callback only compiles a `WorkerPacket` from each `QcRepairPacket` the loop hands it and invokes the selected execution adapter. It does not special-case `operator-review`, add extra timeout logic, or override loop routing decisions.
- `validateQcRepairLoopGate()` (Step 5.9, after the completed-cluster QC trigger and before the authoritative completed-child cross-check) blocks finalize unless `state.qc_repair_loop.terminal_outcome` is a trusted value. The gate is skipped entirely when `config.qc.enabled` is false, or when `config.qc.repairRouting` is not `"route"`/`"follow-up"`.
- Trusted terminal outcomes that allow finalize to proceed (`TRUSTED_QC_REPAIR_OUTCOMES` in `index.ts`): `"pass"`, `"qc-disabled"`, `"no-repairable"`.
- Blocking conditions: any other terminal outcome (`"all-providers-failed"`, `"operator-review"`, `"medic-referral"`, `"max-rounds"`), a `null`/in-flight `terminal_outcome`, or a missing `qc_repair_loop` state entirely (the parent loop never ran the repair loop) when the gate is active.
- `validateQcRepairLoopGate()` also accepts a valid operator resolution artifact (`resolution.json`, written by `polaris qc resolve`) for the current repair round as equivalent to a trusted terminal outcome, without mutating `state.qc_repair_loop`. See `src/qc/POLARIS.md` "Operator resolution" for the artifact contract.
- When completed-cluster QC passes directly, `runCompletedClusterQcWithRepair()` records `qc_repair_loop.terminal_outcome = "pass"` in the state so the gate passes cleanly.
- `validateAuthoritativeChildState()` (Step 5.10) cross-checks `state.completed_children.length` against cluster-state `child_states`; a stale or mismatched cluster-state aborts finalize before the final commit. Its authoritative count — not the raw loop-state count — is what `stepCreatePr` and `stepUpdateLinear` write into the PR body and Linear comment via `authoritativeChildCount`.
- `warnOnMissingQcArtifacts()` (Step 5.6, alongside branch custody verification) is a non-blocking warning: it logs when a cluster-state QC pointer's primary artifact or raw audit artifact is missing, via `validateQcArtifactPointers()` from `src/qc/artifacts.ts`.
- Repair packet manifests (`.polaris/clusters/<cluster-id>/qc/repair-rounds/<round>/repair-packets.json`) are durable Polaris artifacts and must be promoted by `artifact-policy.ts` rules when they exist.
- See `smartdocs/specs/active/quality-control-architecture.md §8.9` for the telemetry-aligned terminal outcome catalog that matches these string values.

## Related routes

- `polaris.finalize` — all files in this directory
