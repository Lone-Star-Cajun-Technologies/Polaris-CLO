---
name: polaris-catalog-step-05
description: Commit all cognition and document changes as a single sealed catalog commit.
---

# Step 05 — Catalog commit

## Purpose

All changes produced by steps 02–04 must be committed as a single sealed commit.
This separates implementation commits from documentation and cognition reconciliation.

## Commit constraints

The catalog commit MUST:
- Contain only files from `packet.allowed_write_paths`
- Contain no implementation source code
- Contain no runtime state files (`current-state.json`, telemetry JSONL, cluster-state)

If any staged file would violate these constraints, unstage it and record as a blocker.

## No-change case

If steps 02–04 produced no file changes, this step is a no-op. Record `commit_sha: null`.
Do not create an empty commit.

## Commit message format

```text
docs(catalog): reconcile cognition and classify docs for <issue_id>

Run: <run_id>
Issue: <issue_id>
Files updated:
- POLARIS.md: <count> files
- SUMMARY.md: <count> files
- docs placed: <count>
- docs held in raw: <count>
```

## Actions

### 5.1 Pre-commit validation

Verify:
1. Every file to be committed is in `packet.allowed_write_paths`.
2. No file is in `packet.prohibited_write_paths`.
3. At least one non-empty change exists.

If prohibited files are staged: `git reset HEAD <file>` before committing.

### 5.2 Stage changed files

```bash
git add <polaris_md_updates[*].file where action == "update">
git add <summary_md_updates[*].file where action == "update">
git add <docs_placed[*].target>
```

### 5.3 Verify staged files

Run `git diff --cached --name-only` and confirm all staged files are in
`packet.allowed_write_paths` and none are in `packet.prohibited_write_paths`.

### 5.4 Commit

```bash
git commit -m "<commit message>"
```

Capture the resulting commit SHA.

### 5.5 Finalize

Update `.taskchain_artifacts/polaris-catalog/current-state.json`:
- `status: complete`
- `current_step_id: 05-catalog-commit`
- `commit_sha: <sha or null>`
- `completed_at: <ISO timestamp>`

Emit `catalog-commit` and `catalog-complete` telemetry events.

Report summary:
```text
polaris-catalog complete
Issue:           <issue_id>
Mode:            interactive | unattended
POLARIS.md:      <count> files updated
SUMMARY.md:      <count> files updated
Docs placed:     <count>
Docs held raw:   <count> (<filenames if any>)
Commit:          <sha> | no changes
Blockers:        <none | list>
```
