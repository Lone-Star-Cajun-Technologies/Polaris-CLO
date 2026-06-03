---
name: polaris-run-step-09-final-delivery
description: Run polaris finalize to push, open the PR, emit JSONL closeout events, and archive the run snapshot. Proceeds only after Closeout Librarian succeeds.
---

# Step 09 — Final Delivery

## Purpose

Complete the parent cluster via `polaris finalize run` — the Polaris runtime handles push,
PR, telemetry, and archive.

This step runs ONLY after the Closeout Librarian in step 08 has completed successfully
(status: `"success"` or `"partial"`).

## Preconditions (verify before proceeding)

- All children in this parent cluster are marked Done in Linear.
- Closeout Librarian completed (step 08) with status `"success"` or `"partial"`.
- The branch is clean (no uncommitted changes beyond the librarian commit).

If any precondition fails: stop and report the gap.

## Scope Declarations

```yaml
allowed_files:
  - .taskchain_artifacts/polaris-run/current-state.json
  - .taskchain_artifacts/polaris-run/runs/*.jsonl
  - .taskchain_artifacts/polaris-run/run-report.md
  - git log and branch metadata
allowed_routes:
  - CLAUDE.md
  - .polaris/skills/polaris-run/chain.md
expected_evidence:
  - closeout librarian completed (step 08)
  - all children Done in Linear
  - polaris finalize executed successfully
  - PR URL recorded
  - run-complete event in telemetry JSONL
stop_rules:
  - closeout librarian not completed or failed
  - any child is not Done
  - branch has uncommitted changes
  - polaris finalize fails
```

## Actions

1. Verify step 08 (Closeout Librarian) completed with `"success"` or `"partial"` status.
2. Verify all children are Done in Linear (re-fetch, do not assume).
3. Verify the working tree is clean.
4. Run:
   ```bash
   npm run polaris -- finalize run
   ```

   `npm run polaris -- finalize run` executes the full finalize sequence:
   - Validates the Polaris map
   - Validates `current-state.json` schema
   - Runs targeted checks
   - Generates `run-report.md`
   - Commits any pending artifacts
   - Pushes the branch (including the librarian commit)
   - Opens a draft PR targeting `main`
   - Updates `current-state.json` to `status: complete`
   - Appends `pr-opened` and `run-complete` events to telemetry JSONL
   - Updates Linear parent with PR URL
   - Archives the run snapshot to `.polaris/runs/<run-id>/`

5. Add a final evidence comment to the Linear parent issue including the PR URL, `run_id`,
   and `librarian_commit` SHA (from step 08).

## PR Body Requirements (handled by polaris finalize — verify the generated PR includes)

- Completed child issue IDs and titles
- Summary of files changed
- Validation result
- Librarian commit SHA and summary (from step 08 result)
- Residual risks (if any)
- Run metadata footer:
  ```text
  ---
  Run-ID: <run_id>
  Skill: polaris-run
  Tracker: linear / <parent_issue_id>
  Librarian-Commit: <commit_sha or none>
  Librarian-Status: <status>
  Related-Run-ID: <related_run_id or omit if null>
  ```

## Artifact Update

`polaris finalize` handles all artifact updates. Verify afterward:

- `.taskchain_artifacts/polaris-run/current-state.json`: `status: complete`
- `.taskchain_artifacts/polaris-run/run-report.md`: exists and complete
- Telemetry JSONL: ends with `run-complete` event

Do not report completion until these are verified.

## Session End

This is the terminal step.
