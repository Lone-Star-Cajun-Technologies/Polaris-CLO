---
name: polaris-run-step-06-commit-and-update-linear
description: Commit changed files, run polaris map update --changed to index them, add evidence to Linear, and mark the child Done.
---

# Step 06 — Commit and update Linear

## Purpose

Record completed work in git, index changed files in the Polaris atlas, and update Linear before deciding whether to continue.

## Scope declarations

```yaml
allowed_files:
  - changed files from current child
  - .taskchain_artifacts/polaris-run/current-state.json
  - .taskchain_artifacts/polaris-run/runs/*.jsonl
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-run/chain.md
expected_evidence:
  - commit created with child ID prefix
  - polaris map update --changed executed (non-fatal on partial failure)
  - Linear evidence comment added with run_id
  - child marked Done only after criteria pass
stop_rules:
  - unexpected files appear in diff
  - Linear update or commit fails
  - child acceptance criteria not met
```

## Actions

1. Stage only the files changed by the current child:
   ```bash
   git add <changed files>
   ```
   Do not stage unrelated files.
2. Commit with the child ID prefix:
   ```bash
   git commit -m "[<CHILD-ID>] <child title>"
   ```
3. **Run `npm run polaris -- map update --changed`** (Polaris-specific addition):
   ```bash
   npm run polaris -- map update --changed
   ```
   Non-fatal if the map is not yet fully implemented — log a warning and continue.
4. Re-fetch the current child issue from Linear to get latest acceptance criteria.
5. Add a concise evidence comment to the Linear child issue. The comment must open with:
   ```yaml
   run_id: <run_id>
   skill: polaris-run
   ```
   Followed by: what was done, commit hash, validation result from step 05.
6. Mark the child Done in Linear **only if** its acceptance criteria are satisfied.
   - If criteria are not met: leave the child open, add a comment with the gap, treat as blocked.

## Blocker escalation

If the child cannot be marked Done:
- Run `npm run polaris -- loop abort "<reason>"`.
- Add a comment with the unblock condition.
- Halt. Do not continue to the next child.

## Artifact update

If no blocker:

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `current_step_id: 06-commit-and-update-linear`
- `last_commit: <hash>`
- `active_child` moved to `completed_children`
- `context_budget.children_completed` incremented
- `updated_at: <timestamp>`

Emit `step-complete` for `06-commit-and-update-linear` to telemetry JSONL.

If blocker escalation:
- `status: blocked`
- `current_step_id: halted`
- `updated_at: <timestamp>`

## Next step

07-decide-continuation (or halted if blocker escalation triggered)
