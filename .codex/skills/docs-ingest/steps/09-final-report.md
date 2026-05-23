---
name: docs-ingest-step-09-final-report
description: Summarize all ingest decisions, report unresolved items, deliver the PR, and close the run artifact.
---

# Step 09 — Final report

## Purpose

Produce the complete run summary, deliver the work through a PR, and mark the artifact complete.

## Preconditions (verify before proceeding)

- All notes in the original queue have an entry in `processed` or `blocked` in the artifact.
- Step 08 graph verification has completed.
- If any newly canonized note is `INTEGRITY-BLOCKED`: stop. Do not create a PR until broken links are resolved or explicitly deferred.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/docs-ingest/current-state.json
  - git status and diff metadata for docs-ingest changes
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - processed/moved/blocked files summarized
  - validation evidence listed
  - PR requirement decision recorded
stop_rules:
  - artifact state incomplete
  - blocked file lacks unblock condition
  - changed run needs delivery but branch/PR state is unavailable
```
## Actions

### Part A — Validate diff scope

1. Review the git diff and confirm it contains only the intended ingest changes:
   - canonized note files in `docs/evonotes/`,
   - moved or archived files in `docs/raw/`,
   - folder README traversal row additions,
   - YAML backlink updates to related notes,
   - root traversal map updates (if a new subfolder was created).

2. Verify no runtime code, non-doc source files, or unrelated doctrine notes were modified.

### Part B — Produce the run summary

Emit the complete run summary in this format:

```text
ROUTED TO AUDITS:       N files  → list each
ARCHIVED (duplicate):   N files  → list each
CANONIZED:              N files  → list each with destination
DEPRECATED:             N files  → list each with reason
ARCHIVED (misc):        N files  → list each
BLOCKED:                N files  → list each with reason

README UPDATES:         N folders updated  → list each folder
BACKLINK UPDATES:       N related notes updated  → list each file
BACKLINK SWEEP:         N orphaned notes repaired, N UNLINKED-BLOCKED  → list each

ORPHANS DETECTED:       N files  → list each
MISSING INDEXES:        N folders  → list each
BROKEN WIKI-LINKS:      N links  → list each (file + broken target)
BROKEN YAML BACKLINKS:  N links  → list each (file + broken target)
INTEGRITY-BLOCKED:      N notes  → list each with reason
INSTRUCTIONS WARNINGS:  N warnings → list each missing destination or first-wave folder warning

FOLLOW-UP ITEMS:        list any out-of-scope observations
```

If all counts are zero, include the section with "0 — none" rather than omitting it.

### Part C — Deliver the PR

If any files changed:

1. Stage and commit the ingest changes with a docs commit message referencing the run ID:
   ```text
   docs: ingest run <run_id> — N canonized, N routed, N backlinks normalized
   ```

2. Push the branch.

3. Create or update a GitHub PR targeting the required base branch:
   - PR title: `docs: ingest run <run_id>`
   - PR body must include:
     - canonized files and destinations,
     - related notes updated for backlinks,
     - graph verification results (orphans, broken links),
     - `INSTRUCTIONS.md` coverage warnings,
     - known warnings or unresolved items,
     - any `INTEGRITY-BLOCKED` or `CONFLICT-BLOCKED` notes that were deferred.

4. Do not claim delivery complete until a real PR URL exists.

If no files changed: report "no ingest changes — PR delivery not applicable."

## Artifact update (required before reporting completion)

Update `.taskchain_artifacts/docs-ingest/current-state.json` BEFORE producing the final user-facing response:

```yaml
status: complete
last_completed_step: 09-final-report
next_step: none
completed_at: <YYYY-MM-DD HH:mm>
notes: |
  <append PR URL>
  <append any INTEGRITY-BLOCKED or CONFLICT-BLOCKED items deferred>
```

Do not report completion until this write succeeds and the artifact reflects `status: complete`.

## Session end

This is the terminal step. Do not start another ingest queue in this session.
