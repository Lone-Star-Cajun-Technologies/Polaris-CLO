---
name: polaris-run-step-07-decide-continuation
description: Run polaris loop continue to checkpoint state and generate the bootstrap packet, then route to adapter handoff, STOP, or DELIVER.
---

# Step 07 — Decide continuation

## Purpose

Checkpoint session state via the Polaris runtime. After a child completes, preserve the token boundary by dispatching any next child through the configured execution adapter instead of continuing implementation inline.

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
  - adapter handoff, STOP, or DELIVER decision recorded
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

### ADAPTER HANDOFF (child-complete) — default after every child

After any child completes and another child remains open:
- Report only compact state: last completed child ID, commit hash, next open child ID and title.
- Dispatch the next child via the configured execution adapter.
- In interactive-agent mode, use the agent/subtask adapter; do not shell out to a nested CLI session.
- In terminal mode, `scripts/polaris-run.sh` is the `terminal-cli` adapter and may invoke the configured CLI command.
- Do not push. Do not create a PR.

This is the normal case. The adapter boundary is the token boundary.

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
