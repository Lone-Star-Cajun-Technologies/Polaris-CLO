---
name: polaris-run-step-07-decide-continuation
description: Run polaris loop continue to checkpoint state and generate the bootstrap packet, then route to CONTINUE, STOP, or DELIVER based on its output and budget state.
---

# Step 07 — Decide continuation

## Purpose

Checkpoint session state via the Polaris runtime, then determine the correct next action.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/polaris-run/current-state.json
  - .taskchain_artifacts/polaris-run/runs/*.jsonl
  - .polaris/runs/current-state.json
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-run/chain.md
expected_evidence:
  - polaris loop continue executed
  - bootstrap packet emitted
  - CONTINUE, STOP, or DELIVER decision recorded
stop_rules:
  - polaris loop continue exits non-zero (excluding expected boundary event)
  - budget threshold reached
  - all children Done but delivery not yet requested
```

## Actions

1. Run:
   ```bash
   polaris loop continue
   ```
   This checkpoints `.polaris/runs/current-state.json`, emits a `loop-checkpoint` JSONL event, runs `polaris map update --changed` (idempotent), checks the analyze→implement boundary, and writes a bootstrap packet to `.polaris/bootstrap/`.

2. Evaluate the output to determine the continuation decision:

### CONTINUE

Proceed if ALL hold:
- `polaris loop continue` exits 0 with no `boundary_enforcement` field.
- `context_budget.children_completed < 4`
- `context_budget.files_touched_total ≤ 50`
- `context_budget.last_child_files_touched ≤ 20`
- Open children remain.

→ Return to step 03.

### STOP (token/context risk)

Halt if ANY budget threshold is met:
- `context_budget.children_completed ≥ 4`
- `context_budget.files_touched_total > 50`
- `context_budget.last_child_files_touched > 20`

Report: last completed child ID, commit hash, next open child ID and title.
Provide resume command: `polaris loop resume`.
Do not push. Do not create a PR.

### STOP (all-done, awaiting delivery)

If all children are Done but delivery was not explicitly requested:
- Halt cleanly.
- Report: all children Done, branch name, last commit.
- Provide delivery command: `Use polaris-run on <PARENT-ID>. Finalize delivery.`
- Do not push. Do not create a PR.

### DELIVER

Proceed to step 08 only if:
- All children are Done (confirmed via Linear).
- The user explicitly requested delivery in this session invocation.

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `status: <continuing | stopped | delivering>`
- `current_step_id: 07-decide-continuation`
- `updated_at: <timestamp>`

## Next step

03-select-child (CONTINUE), halted (STOP), or 08-final-delivery (DELIVER)
