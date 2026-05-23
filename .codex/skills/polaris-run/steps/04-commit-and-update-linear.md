---
name: polaris-run-step-04-commit-and-update-linear
description: Commit the child's changes and mark the child Done in Linear.
---

# Step 04 — Commit and update Linear

## Purpose

Atomically checkpoint the completed child in git and Linear before advancing the loop.

## Scope declarations

```yaml
allowed_files:
  - any files changed by the active child
  - .polaris/runs/current-state.json
expected_evidence:
  - git commit created with child ID prefix
  - child marked Done in Linear
stop_rules:
  - uncommitted changes exist outside the child's scope
  - commit fails
  - Linear update fails
```

## Actions

1. Stage only the files changed by the active child:
   ```
   git add <changed files>
   ```
2. Commit with the child ID prefix:
   ```
   git commit -m "[<CHILD-ID>] <child title>"
   ```
3. Mark the child Done in Linear.
4. Note the commit hash for the session report.

## Artifact update

Update `.polaris/runs/current-state.json`:
- Move `active_child` to `completed_children`
- Clear `active_child: ""`
- Increment `context_budget.children_completed`
- Update `last_commit` to the new commit hash
- `status: checkpoint`

## Next step

05-advance-loop
