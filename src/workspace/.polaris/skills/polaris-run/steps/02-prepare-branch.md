---
name: polaris-run-step-02-prepare-branch
description: Create or reuse the parent-scoped git branch from the Linear issue's gitBranchName and verify a clean execution state.
---

# Step 02 — Prepare branch

## Purpose

Establish a clean, parent-scoped git branch before child execution begins.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/polaris-run/current-state.json
  - git branch and worktree metadata only
allowed_routes:
  - CLAUDE.md
  - .polaris/skills/polaris-run/chain.md
allowed_skills:
  - repo-analysis
expected_evidence:
  - target branch identified or created from main
  - dirty checkout policy applied
  - Linear issue branch name used
stop_rules:
  - unrelated dirty checkout cannot be isolated
  - target branch conflicts with existing delivery branch
  - branch cannot be created from main
```

## Actions

1. Use the branch name from the Linear parent issue's `gitBranchName` field as the authoritative branch name. This field provides the exact branch name to use (typically formatted like `philmeaux/<pol-id>-<slug>`, though format may vary). Do not invent or modify the branch name.
2. If the branch already exists: check it out and verify the working tree is clean. If dirty: halt and instruct the user to commit or stash changes before continuing.
3. If the branch does not exist: create it from `main`.
4. Confirm no uncommitted changes from a different parent cluster exist. If `.taskchain_artifacts/polaris-run/current-state.json` records a different `cluster_id`, halt and report.
5. Do not commit anything at this step.

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `status: ready`
- `branch: <branch-name>`
- `current_step_id: 02-prepare-branch`
- `updated_at: <timestamp>`

Do not emit per-step `step-complete` telemetry. Telemetry is checkpoint-only (`run-start`, `child-dispatched`, child completion/checkpoint events, session end, and blocker/state-repair events).

## Next step

03-select-child
