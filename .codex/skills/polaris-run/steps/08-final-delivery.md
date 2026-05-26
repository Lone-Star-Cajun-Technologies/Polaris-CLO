---
name: polaris-run-step-08-final-delivery
description: Run polaris finalize to push, open the draft PR, emit JSONL closeout events, and archive the run snapshot.
---

# Step 08 — Final delivery

## Purpose

Complete the parent cluster via `polaris finalize` — the Polaris runtime handles push, PR, telemetry, and archive.

## Preconditions (verify before proceeding)

- All children in this parent cluster are marked Done in Linear.
- The branch is clean (no uncommitted changes).

If any precondition fails: stop and report the gap.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/polaris-run/current-state.json
  - .taskchain_artifacts/polaris-run/runs/*.jsonl
  - .taskchain_artifacts/polaris-run/run-report.md
  - git log and branch metadata
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-run/chain.md
expected_evidence:
  - all children Done in Linear
  - polaris finalize executed successfully
  - PR URL recorded
  - run-complete event in telemetry JSONL
stop_rules:
  - any child is not Done
  - branch has uncommitted changes
  - polaris finalize fails
```

## Actions

1. Verify all children are Done in Linear (re-fetch, do not assume).
2. Verify the working tree is clean.
3. Run:
   ```bash
   npm run polaris -- finalize
   ```
   `npm run polaris -- finalize` executes the full 12-step sequence:
   - Validates the Polaris map
   - Validates `current-state.json` schema
   - Runs targeted checks
   - Generates `run-report.md`
   - Commits any pending artifacts
   - Pushes the branch
   - Opens a draft PR targeting `main`
   - Updates `current-state.json` to `status: complete`
   - Appends `pr-opened` and `run-complete` events to telemetry JSONL
   - Updates Linear parent with PR URL
   - Archives the run snapshot to `.polaris/runs/<run-id>/`

4. Add a final evidence comment to the Linear parent issue including the PR URL and `run_id`.

## PR body requirements (handled by polaris finalize — verify the generated PR includes)

- Completed child issue IDs and titles
- Summary of files changed
- Validation result
- Residual risks (if any)
- Run metadata footer:
  ```text
  ---
  Run-ID: <run_id>
  Skill: polaris-run
  Tracker: linear / <parent_issue_id>
  Related-Run-ID: <related_run_id or omit if null>
  ```

## Artifact update

`polaris finalize` handles all artifact updates. Verify afterward:

- `.taskchain_artifacts/polaris-run/current-state.json`: `status: complete`
- `.taskchain_artifacts/polaris-run/run-report.md`: exists and complete
- Telemetry JSONL: ends with `run-complete` event

Do not report completion until these are verified.

## Session end

This is the terminal step.
