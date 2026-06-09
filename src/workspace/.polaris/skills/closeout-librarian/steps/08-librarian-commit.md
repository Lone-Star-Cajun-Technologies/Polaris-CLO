---
name: closeout-librarian-step-08
description: Commit all documentation and cognition changes as a single sealed librarian commit.
---

# Step 08 — Librarian Commit

## Purpose

All documentation changes produced by steps 03–07 must be committed as a single commit
before the Foreman proceeds to finalize. This separates implementation commits (from workers)
from documentation reconciliation commits (from the Librarian).

## Commit Constraints

The Librarian commit MUST:
- Contain only files from `packet.allowed_write_paths`
- Contain no implementation source code
- Contain no runtime state files (`current-state.json`, telemetry JSONL, cluster-state)
- Be a distinct commit from any worker implementation commit
- Use the canonical commit message format (see below)

If any staged file would violate these constraints, unstage it and record as a blocker.

## Pre-Commit Validation

Before staging, verify:
1. Every file to be committed exists at a path within `packet.allowed_write_paths`.
2. No file is at a path matching `packet.prohibited_write_paths`.
3. At least one non-empty change exists (if no changes, skip commit and record no-op).

If prohibited files are staged: `git reset HEAD <file>` before committing.

## No-Change Case

If steps 03–07 produced no file changes (everything was already current), step 08 is a
no-op. Record `commit_sha: null` in the result. The Foreman will accept a null commit SHA
from the Librarian result.

## Commit Message Format

```text
docs(closeout): reconcile cognition for cluster <cluster_id>

Run: <run_id>
Cluster: <cluster_id>
Children: <comma-separated completed child IDs>
Files updated:
- POLARIS.md: <count> files
- SUMMARY.md: <count> files
- docs ingested: <count>
- links repaired: <count>
```

Example:
```text
docs(closeout): reconcile cognition for cluster POL-303

Run: polaris-run-closeout-librarian-2026-06-03-001
Cluster: POL-303
Children: POL-304, POL-305, POL-306, POL-307
Files updated:
- POLARIS.md: 3 files
- SUMMARY.md: 2 files
- docs ingested: 1
- links repaired: 2
```

## Actions

### 8.1 Stage Changed Files

Stage all files that were written in steps 03–07:
```bash
git add <polaris_md_updates[*].file>
git add <summary_md_updates[*].file>
git add <docs_ingested[*].target_path>
git add <yaml_updates[*].file>
git add <cognition archive paths>
git add <cognition-index.json paths>
```

### 8.2 Verify Staged Files

Run `git diff --cached --name-only` and verify:
- All staged files are in `packet.allowed_write_paths`
- None are in `packet.prohibited_write_paths`

If any violation: unstage the offending file, record as blocker.

### 8.3 Commit

If staged files exist:
```bash
git commit -m "<commit message>"
```

Capture the resulting commit SHA.

### 8.4 Record

Record the commit SHA and list of committed files for step 09.

## Failure Handling

If `git commit` fails:
- Record `status: "failure"` in the running result state.
- Record the commit error in `blockers`.
- Proceed to step 09 (write failure result).

If no files were staged (no-change case):
- Record `commit_sha: null`.
- Proceed to step 09.

## Emit Telemetry

Emit `librarian-commit` event with `commit_sha` and `files_changed` count.

Proceed to step 09.
