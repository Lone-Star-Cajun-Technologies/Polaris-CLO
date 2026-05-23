---
name: polaris-analyze-step-05-advance-loop
description: Run polaris loop continue and route to CONTINUE, BOUNDARY, STOP, or FINALIZE.
---

# Step 05 — Advance loop

## Purpose

Checkpoint state via Polaris, then decide whether to continue analyzing, stop for budget, halt on boundary, or finalize.

## Scope declarations

```yaml
allowed_files:
  - .polaris/runs/current-state.json
expected_evidence:
  - polaris loop continue executed
  - decision determined from output and budget state
  - decision recorded in current-state.json
stop_rules:
  - polaris loop continue fires boundary enforcement event
  - budget threshold reached
  - all analyze children Done
```

## Actions

1. Run:
   ```
   polaris loop continue
   ```
   This checkpoints state, runs `polaris map update --changed`, checks for non-doc mutations (scope enforcement), and emits a bootstrap packet.

2. Evaluate the continuation decision:

### BOUNDARY

If `polaris loop continue` emits `boundary_enforcement: true`: halt.

Report:
- Last completed analyze child and commit hash
- First implement child waiting to run
- Instruction: "Start a new polaris-run session to execute implement children."

Do not push. Do not create a PR. Do not finalize.

### CONTINUE

Proceed if ALL hold:
- No boundary enforcement event
- `context_budget.children_completed < 3`
- `open_children` is not empty
- Next open child is `session_type: analyze`

→ Return to step 02.

### STOP (budget)

Halt if:
- `context_budget.children_completed ≥ 3`

Report:
- Last completed child and commit hash
- Next open child ID and title
- Resume command: `polaris loop resume`

Do not push. Do not create a PR.

### FINALIZE

Proceed only if:
- `open_children` is empty
- All cluster children (including any implement-type) are Done

```
polaris finalize
```

This applies to analyze-only clusters. Mixed clusters finalize via polaris-run after implement children complete.

## Artifact update

Update `.polaris/runs/current-state.json`:
- `status: continuing | stopped | boundary | complete`
- `step_cursor: <decision>`

## Next step

02-select-child (CONTINUE), halted (BOUNDARY or STOP), or terminal (FINALIZE)
