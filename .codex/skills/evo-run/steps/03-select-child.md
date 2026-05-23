---
name: evo-run-step-03-select-child
description: Identify the lowest-numbered open child, enforce re-fetch guards, and halt on blockers or completion.
---

# Step 03 — Select child

## Purpose

Identify the correct next child to execute without skipping or misordering.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/evo-run/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - gitnexus
expected_evidence:
  - fresh child list fetched
  - lowest-numbered open child or standalone issue selected
  - blocked child state checked
stop_rules:
  - compression_mode_active is false or absent in .taskchain_artifacts/evo-run/current-state.json
  - next child is blocked
  - child ordering is ambiguous
  - parent state changed out of scope
```
## Actions

0. **Verify compression mode is active** before selecting a child.
   - Read `compression_mode_active` from `.taskchain_artifacts/evo-run/current-state.json`.
   - If the field is `false`, absent, or the file cannot be read: halt immediately.
     - Do not select a child.
     - Do not advance to step 04.
     - Emit `blocker-found` telemetry with reason: `compression-mode-inactive`. Format: see `.evo/run-state/event-catalog.md`.
     - Report: "Compression mode was not activated at step 01. Re-run evo-run from the beginning to establish a governed session."
   - If `compression_mode_active` is `true`: continue to action 1.
1. **First child**: use the child list already fetched in step 01 — do not re-fetch.
2. **Child 2 and beyond**: re-fetch the full child list from Linear to catch state changes from the prior child.
3. Filter to open children only (exclude Done and Cancelled).
4. If no open children remain: emit "all children complete" status, update artifact to `status: all-children-complete`, and end the session. Resumption requires an explicit final-delivery invocation — the user runs `Use evo-run on <PARENT-ID>. Finalize delivery, push the branch, and create the draft PR.` which re-enters at step 08.
5. Select the lowest-numbered open child.
6. Verify its Linear state is not Done or Cancelled (re-fetch guard). If it is, skip to the next lowest open child.
7. Check for blockers on the selected child. If blocked:
   - Stop immediately.
   - Do not advance to step 04.
   - Follow the blocker protocol (create Linear blocking relationship, add comment with unblock condition, apply the "Blocked" label — if the label application fails, log a warning with the label name and continue).
   - Do not push. Do not create a PR.
   - Report blocked state and halt.

## Artifact update

After selecting a valid child, update `.taskchain_artifacts/evo-run/current-state.json`:
- `current_step_id: 03-select-child`
- `tracker.current_child_id: <ID>`
- `updated_at: <timestamp>`

If all children are complete:
- `status: all-children-complete`
- `current_step_id: awaiting-delivery-request`

## Next step

04-execute-child (or halt if all children complete or blocked)
