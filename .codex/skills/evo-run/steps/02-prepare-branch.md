---
name: evo-run-step-02-prepare-branch
description: Create or reuse the parent-scoped git branch and verify a clean execution state before child execution begins.
---

# Step 02 — Prepare branch

## Purpose

Establish a clean, parent-scoped git branch before child execution begins.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/evo-run/current-state.json
  - .taskchain_artifacts/evo-run/runs/*.jsonl
  - git branch and worktree metadata only
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - gitnexus
expected_evidence:
  - target branch identified or created from required base
  - dirty checkout policy applied
  - Linear issue state prepared
stop_rules:
  - unrelated dirty checkout cannot be isolated
  - target branch conflicts with existing delivery branch
  - required base branch cannot be fetched
```
## Actions

1. Determine the branch name from the parent issue ID. Format: `evo/<ISSUE-ID>-short-title` where the short title is lowercase, hyphen-separated, derived from the issue title (e.g., `evo/EVOC-123-add-auth-flow`).
2. If the branch already exists, check it out and verify the working tree is clean. If the working tree is dirty, halt and report: instruct the user to commit or stash changes before continuing.
3. If the branch does not exist, create it from the current base branch.
4. Confirm no uncommitted changes from a different parent cluster exist. Check `.taskchain_artifacts/evo-run/current-state.json` for a `tracker.target_id` field and compare it to the current target. If the artifact is blank or matches, proceed. If it conflicts, halt and report.
5. Do not commit anything at this step.

## Artifact update

After completing, update `.taskchain_artifacts/evo-run/current-state.json`:
- `status: ready`
- `branch: <branch-name>`
- `current_step_id: 02-prepare-branch`
- `updated_at: <timestamp>`

## Next step

03-select-child
