---
name: polaris-run-step-07-decide-continuation
description: Run polaris loop continue to checkpoint state and generate the bootstrap packet, then route to STOP or DELIVER. One child per session — always STOP after a child completes.
---

# Step 07 — Decide continuation

## Purpose

Checkpoint session state via the Polaris runtime. One child completes per session — always halt and provide a resume command so the next session starts fresh.

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
  - STOP or DELIVER decision recorded
stop_rules:
  - polaris loop continue exits non-zero (excluding expected boundary event)
  - child just completed (always)
  - all children Done but delivery not yet requested
```

## Actions

1. Run:
   ```bash
   polaris loop continue
   ```
   This checkpoints `.polaris/runs/current-state.json`, emits a `loop-checkpoint` JSONL event, runs `polaris map update --changed` (idempotent), checks the analyze→implement boundary, and writes a bootstrap packet to `.polaris/bootstrap/`.

2. Evaluate the output to determine the decision:

### STOP (child-complete) — default after every child

After any child completes, always halt:
- Report: last completed child ID, commit hash, next open child ID and title.
- Provide resume instruction: start a new session and run `polaris-run on <PARENT-ID>`.
- Do not push. Do not create a PR.

This is the normal case. There is no CONTINUE.

### STOP (boundary_enforcement)

Halt if `polaris loop continue` output contains a `boundary_enforcement` field:
- Report: last completed child ID, commit hash, offending resource counts.
- Provide resume instruction: start a new session and run `polaris-run on <PARENT-ID>`.
- Do not push. Do not create a PR.

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
- `status: stopped`
- `current_step_id: 07-decide-continuation`
- `updated_at: <timestamp>`

## Next step

halted (STOP) or 08-final-delivery (DELIVER)
