---
name: polaris-run-step-06-commit-and-update-linear
description: Record worker return outcomes for the active child and update Linear completion state without inline parent implementation.
---

# Step 06 — Record completion and update Linear

## Purpose

Record worker-returned completion state, update Linear, and prepare for continuation decisions.

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
  - worker return includes commit hash or explicit no-commit status
  - parent completion record written only after return validation
  - Linear evidence comment added with run_id
  - child marked Done only after criteria pass
stop_rules:
  - unexpected files appear in diff
  - Linear update or commit fails
  - child acceptance criteria not met
```

## Actions

1. Read the worker return for the active child and verify completion evidence (status, commit hash when applicable, and validation summary).
2. Re-fetch the current child issue from Linear to get latest acceptance criteria.
3. Add a concise evidence comment to the Linear child issue. The comment must open with:
   ```yaml
   run_id: <run_id>
   skill: polaris-run
   ```
   Followed by: what was done, commit hash, validation result from step 05.
4. Mark the child Done in Linear **only if** its acceptance criteria are satisfied.
   - If criteria are not met: leave the child open, add a comment with the gap, treat as blocked.
5. Do not run `npm run polaris -- map update --changed` per child. Map update belongs at final delivery/session end unless runtime requirements explicitly override this.

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

Telemetry remains checkpoint-only. Do not emit per-step `step-complete` events.

If blocker escalation:
- `status: blocked`
- `current_step_id: halted`
- `updated_at: <timestamp>`

## Next step

07-decide-continuation (or halted if blocker escalation triggered)
