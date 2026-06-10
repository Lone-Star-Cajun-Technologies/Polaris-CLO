---
name: polaris-reconcile-step-04
description: Commit all cognition changes (POLARIS.md and SUMMARY.md updates) as a single sealed reconcile commit.
---

# Step 04 — Reconcile commit

## Purpose

All cognition changes produced by steps 02–03 must be committed as a single sealed commit.
This separates implementation commits from documentation reconciliation commits.

## Commit constraints

The reconcile commit MUST:
- Contain only files from `packet.allowed_write_paths`
- Contain only POLARIS.md and SUMMARY.md changes — no implementation source, no runtime state
- Be a distinct commit from any implementation commit

If any staged file would violate these constraints, unstage it and record as a blocker.

## No-change case

If steps 02–03 produced no file changes (everything was already current), this step is a
no-op. Record `commit_sha: null`. Do not create an empty commit.

## Commit message format

```text
docs(reconcile): update cognition for <issue_id>

Run: <run_id>
Issue: <issue_id>
Files updated:
- POLARIS.md: <count> files
- SUMMARY.md: <count> files
```

## Actions

### 4.1 Pre-commit validation

Verify:
1. Every file to be committed is in `packet.allowed_write_paths`.
2. No file is in `packet.prohibited_write_paths`.
3. At least one non-empty change exists.

If prohibited files are staged: `git reset HEAD <file>` before committing.

### 4.2 Stage changed files

```bash
git add <polaris_md_updates[*].file where action == "update">
git add <summary_md_updates[*].file where action == "update">
```

### 4.3 Verify staged files

Run `git diff --cached --name-only` and confirm all staged files are in
`packet.allowed_write_paths` and none are in `packet.prohibited_write_paths`.

### 4.4 Commit

```bash
git commit -m "<commit message>"
```

Capture the resulting commit SHA.

### 4.5 Finalize

Update `.taskchain_artifacts/polaris-reconcile/current-state.json`:
- `status: complete`
- `current_step_id: 04-reconcile-commit`
- `commit_sha: <sha or null>`
- `completed_at: <ISO timestamp>`

Emit `reconcile-commit` and `reconcile-complete` telemetry events.

Report summary:
```text
polaris-reconcile complete
Issue:      <issue_id>
POLARIS.md: <count> files updated
SUMMARY.md: <count> files updated
Commit:     <sha> | no changes
Blockers:   <none | list>
```
