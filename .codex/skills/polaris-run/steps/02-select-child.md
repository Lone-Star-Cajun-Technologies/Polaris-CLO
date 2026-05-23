---
name: polaris-run-step-02-select-child
description: Select the next executable child from open_children whose blockedBy dependencies are all in completed_children.
---

# Step 02 — Select child

## Purpose

Identify the correct next child without skipping or misordering.

## Scope declarations

```yaml
allowed_files:
  - .polaris/runs/current-state.json
expected_evidence:
  - open_children read from current-state.json
  - next unblocked child identified
  - active_child set
stop_rules:
  - open_children is empty (route to FINALIZE via step 05)
  - no child is unblocked (deadlock — abort)
```

## Actions

1. Read `open_children` and `completed_children` from `.polaris/runs/current-state.json`.
2. If `open_children` is empty: all children are Done — proceed to step 05 with decision FINALIZE.
3. Find the first child in `open_children` whose `blockedBy` entries are all present in `completed_children`.
4. If no child is unblocked: run `polaris loop abort "deadlock — no executable child"`. Report each blocked child and its unresolved blockers. Halt.
5. Set this child as `active_child` in state.

## Artifact update

Update `.polaris/runs/current-state.json`:
- `active_child: <selected-child-id>`
- `status: executing`

## Next step

03-execute-child
