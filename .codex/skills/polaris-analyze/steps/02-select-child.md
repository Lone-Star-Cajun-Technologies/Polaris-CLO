---
name: polaris-analyze-step-02-select-child
description: Select the next executable analyze child whose blockedBy dependencies are all completed.
---

# Step 02 — Select child

## Purpose

Identify the correct next analyze child without skipping or misordering.

## Scope declarations

```yaml
allowed_files:
  - .polaris/runs/current-state.json
expected_evidence:
  - open_children read from current-state.json
  - next unblocked analyze child identified
  - active_child set
stop_rules:
  - open_children is empty (route to FINALIZE via step 05)
  - selected child is session_type: implement (boundary — halt via step 05)
  - no child is unblocked (deadlock — abort)
```

## Actions

1. Read `open_children` and `completed_children` from `.polaris/runs/current-state.json`.
2. If `open_children` is empty: all analyze children are Done — proceed to step 05 with decision FINALIZE (or BOUNDARY if implement children remain in the cluster).
3. Find the first child in `open_children` whose `blockedBy` entries are all in `completed_children`.
4. If the next unblocked child is `session_type: implement`: proceed to step 05 with decision BOUNDARY.
5. If no child is unblocked: run `polaris loop abort "deadlock — no executable analyze child"`. Report each blocked child and its unresolved blockers. Halt.
6. Set this child as `active_child` in state.

## Artifact update

Update `.polaris/runs/current-state.json`:
- `active_child: <selected-child-id>`
- `status: executing`

## Next step

03-execute-child
