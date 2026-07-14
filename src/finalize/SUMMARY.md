# Summary: finalize

## Purpose
Atomic 14-step delivery sequence — the only subsystem that pushes branches, opens PRs, and closes Linear issues.

## Key behaviors
- Steps are sequenced exclusively by `runFinalize`; steps do not call each other.
- Tracker reconciliation runs before the final commit and only from validated cluster-state/result evidence.
- Remote delivery steps after the commit are skipped under `--dry-run` or `--skip-delivery`.
- `stepCommit` commits exactly: state + map + run-report. Nothing else.
- `validateMedicGate()` blocks finalize when a run-health report exists without a Medic decision or explicit bypass.
- Only `polaris finalize` may call `git push`.
- PR creation (step 10) is the terminal tracked-repo-state mutation; the Linear update (step 13) calls `updateLinearIssueAfterFinalize()` directly (not a `steps/` file) to make the external tracker call, and post-PR local bookkeeping (state, archive, cluster-state `pr_url`) stays in git-ignored paths.
- Durable Polaris artifacts are staged (step 5.75) before the completed-cluster QC trigger runs, so QC reviews the same promoted artifacts that land in the final delivery commit.
- Completed-cluster QC blocks now trigger the QC repair loop during finalize when repair routing is active, so repair packets can be compiled/dispatched in-band before the terminal-state gate.
- `runCompletedClusterQcWithRepair()` escalates untrusted completed-cluster and repair-loop QC outcomes to the run-health report as symptoms before the terminal gate.
- `validateQcRepairLoopGate()` blocks finalize unless the QC repair loop's `terminal_outcome` is `"pass"`, `"qc-disabled"`, or `"no-repairable"` (when QC + repair routing are active), or a valid operator resolution artifact exists for the current repair round (written by `polaris qc resolve`).
- `stepCreatePr` blocks PR creation if the branch's current HEAD no longer matches `qc_repair_loop.sealed_head_sha`, the SHA sealed when QC last reviewed the branch.
- The run report and Linear finalize-complete comment now include auditable QC convergence evidence: sealed reviewed SHA, PR head SHA, QC review pass count, unresolved advisory-severity finding count, and repair loop outcome (`run-report.ts` `computeRunReportQcEvidence`).
- `validateAuthoritativeChildState()` cross-checks completed-child counts against cluster-state before PR creation; its authoritative count is used in the PR body and Linear comment instead of the raw loop-state count.

## Relationships
- **Upstream**: `src/loop/checkpoint.ts` (`current-state.json`), `src/map` (step 01 atlas update)
- **Downstream**: GitHub (PR creation), Linear (issue update)

## Current State
The finalize subsystem owns the atomic delivery sequence, QC gating, and the run-health Medic gate. It commits state, map, and run-report artifacts only, then optionally proceeds to PR creation and tracker updates when the QC and Medic gates pass. Run-health reports now block delivery until Medic resolves or bypasses them, and the QC repair loop continues to gate finalize independently of the Medic check. `runCompletedClusterQcWithRepair()` now delegates directly to `runQcRepairLoop()` and escalates untrusted completed-cluster and repair-loop QC outcomes to the run-health report as symptoms before the terminal gate. Finalize still remains the only subsystem that pushes branches and opens PRs.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `smartdocs/specs/active/polaris-implementation-plan.md`
