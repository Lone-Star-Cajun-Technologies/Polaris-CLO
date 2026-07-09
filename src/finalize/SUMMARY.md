# Summary: finalize

## Purpose
Atomic 13-step delivery sequence — the only subsystem that pushes branches, opens PRs, and closes Linear issues.

## Key behaviors
- Steps are sequenced exclusively by `runFinalize`; steps do not call each other.
- Tracker reconciliation runs before the final commit and only from validated cluster-state/result evidence.
- Remote delivery steps after the commit are skipped under `--dry-run` or `--skip-delivery`.
- `stepCommit` commits exactly: state + map + run-report. Nothing else.
- Only `polaris finalize` may call `git push`.
- `validateQcRepairLoopGate()` blocks finalize unless the QC repair loop's `terminal_outcome` is `"pass"`, `"qc-disabled"`, or `"no-repairable"` (when QC + repair routing are active).
- `validateAuthoritativeChildState()` cross-checks completed-child counts against cluster-state before PR creation; its authoritative count is used in the PR body and Linear comment instead of the raw loop-state count.

## Relationships
- **Upstream**: `src/loop/checkpoint.ts` (`current-state.json`), `src/map` (step 01 atlas update)
- **Downstream**: GitHub (PR creation), Linear (issue update)

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `docs/spec/polaris-architecture-spec.md`
