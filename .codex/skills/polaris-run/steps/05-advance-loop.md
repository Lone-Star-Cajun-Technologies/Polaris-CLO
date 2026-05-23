---
name: polaris-run-step-05-advance-loop
description: Run polaris loop continue and route to CONTINUE, STOP, or FINALIZE based on remaining children and budget state.
---

# Step 05 — Advance loop

## Purpose

Checkpoint state via Polaris, then decide whether to continue, stop, or finalize.

## Scope declarations

```yaml
allowed_files:
  - .polaris/runs/current-state.json
expected_evidence:
  - polaris loop continue executed
  - bootstrap packet emitted (if continuing or stopping)
  - decision recorded in current-state.json
stop_rules:
  - polaris loop continue fails
  - budget threshold reached
  - all children Done
```

## Actions

1. Run:
   ```
   polaris loop continue
   ```
   This checkpoints state, runs `polaris map update --changed`, checks the analyze→impl boundary, and emits a bootstrap packet.

2. Evaluate the continuation decision:

### CONTINUE

Proceed if ALL hold:
- `context_budget.children_completed < 3`
- `open_children` is not empty

→ Return to step 02.

### STOP (budget)

Halt if:
- `context_budget.children_completed ≥ 3`

Report:
- Last completed child ID and commit hash
- Next open child ID and title
- Resume command: `polaris loop resume`

Do not push. Do not create a PR.

### FINALIZE

Proceed if `open_children` is empty and all children are Done:

```
polaris finalize
```

This pushes the branch, opens a draft PR, and archives the run snapshot.

## Artifact update

Update `.polaris/runs/current-state.json`:
- `status: continuing | stopped | complete`
- `step_cursor: <decision>`

## Next step

02-select-child (CONTINUE), halted (STOP), or terminal (FINALIZE)
