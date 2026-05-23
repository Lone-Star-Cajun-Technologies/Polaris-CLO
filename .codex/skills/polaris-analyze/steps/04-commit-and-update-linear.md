---
name: polaris-analyze-step-04-commit-and-update-linear
description: Stage only doc/spec files, commit with child ID prefix, and mark the child Done in Linear.
---

# Step 04 — Commit and update Linear

## Purpose

Atomically checkpoint the completed analyze child in git and Linear before advancing.

## Scope declarations

```yaml
allowed_files:
  - docs/**
  - docs/spec/**
  - docs/planning/**
  - docs/Polaris/**
expected_evidence:
  - only doc/spec files staged (no src/ or test files)
  - git commit created with child ID prefix
  - child marked Done in Linear
stop_rules:
  - staged files include src/, test files, or config files (scope violation)
  - commit fails
  - Linear update fails
```

## Actions

1. Stage only the doc and spec files produced for this child:
   ```
   git add <doc/spec files only>
   ```
   Do not stage `src/`, test files, or non-doc config changes. If any are accidentally changed, do not commit — abort and report.
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
