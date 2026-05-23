---
name: evo-run-step-06-commit-and-update-linear
description: Commit changed files, add evidence comment to Linear, and mark the child Done only if acceptance criteria pass.
---

# Step 06 — Commit and update Linear

## Purpose

Record completed work in git and Linear before deciding whether to continue.

## Scope declarations

```yaml
allowed_files:
  - changed files from current child
  - .taskchain_artifacts/evo-run/current-state.json
  - .taskchain_artifacts/evo-run/runs/*.jsonl
  - git diff and status metadata
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - none
expected_evidence:
  - GitNexus change detection or equivalent scope check completed
  - commit created when files changed
  - Linear evidence comment added
  - child marked Done only after criteria pass
stop_rules:
  - unexpected files appear in diff
  - change detection reports out-of-scope impact
  - Linear update or commit fails
```
## Actions

1. If files were changed in step 04, commit them to the parent-scoped branch.
   - Write a concise commit message referencing the child issue ID.
   - Do not stage unrelated files.
2. If no files were changed (e.g., the child was documentation-only or already complete), skip the commit.
3. Re-fetch the current child issue from Linear to get its latest state and acceptance criteria.
4. Add a concise evidence comment to the Linear child issue. The comment must open with:
   ```yaml
   run_id: <run_id>
   skill: evo-run
   ```
   Followed by:
   - What was done.
   - Commit hash (if committed).
   - Validation result from step 05.
5. Emit `linear-linked` telemetry event after the comment is successfully added. Format: see `.evo/run-state/event-catalog.md`.
6. Mark the child Done in Linear **only if** its acceptance criteria (from the freshly fetched issue) are satisfied.
   - If acceptance criteria are not met: leave the child open, add a comment with the gap, and treat the session as blocked.
7. Do not push the branch at this step.
8. Do not create a PR at this step.

## Blocker escalation

If the child cannot be marked Done (acceptance criteria fail, unresolvable validation failure, or out-of-scope dependency):
- Stop immediately.
- Create a Linear blocking relationship if appropriate.
- Add a comment with the unblock condition.
- Apply the "Blocked" label; if the label application fails, log a warning with the label name and continue.
- Do not continue to the next child.
- Do not push. Do not create a PR.

## Artifact update

If no blocker escalation was triggered, update `.taskchain_artifacts/evo-run/current-state.json` and append `step-complete` to JSONL telemetry (format: see `.evo/run-state/event-catalog.md`):

- `current_step_id: 06-commit-and-update-linear`
- `last_commit: <hash or "none">`
- `updated_at: <timestamp>`

If blocker escalation was triggered:
- `status: blocked`
- `last_commit: <hash or "none">`
- `current_step_id: halted`
- `updated_at: <timestamp>`

## Next step

07-decide-continuation (or halted if blocker escalation triggered)
