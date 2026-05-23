---
name: evo-run-step-08-final-delivery
description: Run final validation, push the parent-scoped branch, and create the draft PR after all children are Done.
---

# Step 08 — Final delivery

## Purpose

Complete the parent cluster: validate, push, and create the draft PR.

## Preconditions (verify before proceeding)

- All children in this parent cluster are marked Done in Linear.
- The branch is clean (no uncommitted changes).

If any precondition fails, stop and report the gap rather than proceeding.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/evo-run/current-state.json
  - .taskchain_artifacts/evo-run/runs/*.jsonl
  - .taskchain_artifacts/evo-run/run-report.md
  - git diff, log, branch, and PR metadata
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - none
expected_evidence:
  - all children or standalone issue Done
  - final validation recorded
  - branch pushed
  - draft PR targeting required base created
stop_rules:
  - any child or standalone issue incomplete
  - required validation failed
  - push or PR creation unavailable
```
## Actions

1. Run final targeted validation across all changed areas in the parent cluster.
2. Push the parent-scoped branch.
3. Create one draft PR targeting `testing` unless the parent issue explicitly specifies another target.
4. PR title must include the parent issue ID.
5. PR body must include:
   - Completed child issue IDs and titles.
   - Summary of files changed.
   - Validation result.
   - Residual risks (if any).
   - Follow-up issues created during execution (if any).
6. PR body must end with a run metadata footer (required for handoff and lineage):
   ```text
   ---
   Run-ID: <run_id>
   Skill: evo-run
   Tracker: linear / <parent_issue_id>
   Parent-Run-ID: <parent_run_id or omit if null>
   Related-Run-ID: <related_run_id or omit if null>
   ```
7. After the PR is created, emit `pr-metadata` telemetry event. Format: see `.evo/run-state/event-catalog.md`.
8. Add a final evidence comment to the Linear parent issue including the PR URL and the run metadata footer.

## Artifact update (required before reporting completion)

Before giving the final user-facing completion response:

1. Update `.taskchain_artifacts/evo-run/current-state.json`:
   - `status: complete`
   - `current_step_id: null`
   - `last_commit: <commit SHA>`
   - `pr_url: <PR URL>`
   - `completed_at: <timestamp>`
   - `updated_at: <timestamp>`

2. Write `.taskchain_artifacts/evo-run/run-report.md` (generated closeout artifact):
   - Summary of completed children, commits, PR URL, validation result, run_id, residual risks.

3. Emit `run-complete` telemetry event to `.taskchain_artifacts/evo-run/runs/[run-id].jsonl`. Format: see `.evo/run-state/event-catalog.md`.

The final user-facing delivery response must not be produced until both artifact updates and the JSONL telemetry event succeed and reflect completion state.

If any artifact update fails or cannot be verified, stop and report the artifact persistence failure instead of reporting successful completion.

## Session end

This is the terminal step. Do not continue to another parent cluster in this session.
