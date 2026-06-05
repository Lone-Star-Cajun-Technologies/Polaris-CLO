---
name: polaris-run-step-07-decide-continuation
description: Dispatch the next child through polaris loop dispatch when eligible, then run polaris loop continue only after the worker returns.
---

# Step 07 — Decide continuation

## Purpose

Preserve the parent/worker boundary via the Polaris runtime. The parent dispatches child work with `polaris loop dispatch`, waits for the worker's compact return, and only then checkpoints with `polaris loop continue`.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/polaris-run/current-state.json
  - .taskchain_artifacts/polaris-run/runs/*.jsonl
  - .polaris/runs/current-state.json
allowed_routes:
  - CLAUDE.md
  - .polaris/skills/polaris-run/chain.md
expected_evidence:
  - polaris loop dispatch executed when a next child exists
  - worker compact return received before checkpoint
  - polaris loop continue executed
  - bootstrap packet emitted
  - dispatch, STOP, or DELIVER decision recorded
stop_rules:
  - polaris loop dispatch exits non-zero
  - worker compact return is missing or invalid
  - polaris loop continue exits non-zero (excluding expected boundary event)
  - budget exhausted in fixed-cap mode only; children_completed >= budget.max_children from polaris.config.json; does not apply in run-until-done or stop-on-fail modes
  - all children Done but delivery not yet requested
```

## Actions

1. If another child is eligible, dispatch that child:
   ```bash
   npm run polaris -- loop dispatch
   ```
   This invokes the configured execution adapter with exactly one child worker prompt. The parent/orchestrator must not implement the child inline.

2. Wait for the worker compact return. Require child ID, status, commit hash when applicable, validation summary, and next action. Do not ingest worker transcript content.

3. Then run:
   ```bash
   npm run polaris -- loop continue
   ```
   This post-child checkpoint updates `.polaris/runs/current-state.json`, emits a `loop-checkpoint` JSONL event, checks the analyze→implement boundary, and writes a bootstrap packet to `.polaris/bootstrap/`.

4. Evaluate the output to determine the decision:

### DISPATCH (next-child) — default when another child remains

When another child remains open:
- Report only compact state: last completed child ID, commit hash, next open child ID and title.
- Dispatch the next child with `npm run polaris -- loop dispatch` or the execution adapter directly.
- The dispatch adapter is `execution.adapter` from `polaris.config.json`.
- When `execution.providerPolicy.worker.allowNativeSubagent: false`, verify that `execution.adapter` is `terminal-cli` before dispatching.
- If `execution.adapter` is `agent-subtask` or any other unsupported adapter, STOP immediately and report a config/governance/runtime violation — do not attempt native subagent tools. The current runtime adapter registry supports only `terminal-cli` and `agent-subtask`.
- In terminal mode, `scripts/polaris-run.sh` is the `terminal-cli` adapter and may invoke the configured CLI command.
- Wait for the worker compact return before calling `npm run polaris -- loop continue`.
- Do not push. Do not create a PR.

This is the normal case. The dispatch boundary is the token boundary.

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
