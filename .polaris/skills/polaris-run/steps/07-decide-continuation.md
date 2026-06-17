---
name: polaris-run-step-07-decide-continuation
description: Run all eligible children via loop run, then decide continuation (DISPATCH / STOP / DELIVER).
---

# Step 07 — Decide continuation

## Purpose

Execute the cluster's remaining children via the runtime's batch dispatch loop, then determine
whether to continue, halt, or proceed to delivery.

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
  - polaris loop run executed
  - RUNNING <child-id> (N/M) signal emitted per child
  - COMPLETE <child-id> (commit: <sha>) signal emitted per child
  - COMPLETE (cluster-complete) or blocked exit recorded
stop_rules:
  - loop run exits non-zero (blocked or error)
  - budget exhausted in fixed-cap mode (children_completed >= budget.max_children from polaris.config.json)
  - all children Done but delivery not yet requested
```

## Actions

Run the batch dispatch loop:

```bash
polaris loop run <cluster-id>
```

The runtime manages everything internally: child selection, packet compilation, provider dispatch
(with automatic fallback through `providerPolicy.worker.providers`), CompactReturn validation,
and state checkpointing. The Foreman must not call `loop dispatch` or `loop continue` individually.

Monitor the subprocess output for progress signals:
- `[POLARIS] RUNNING <child-id> (N/M)` — child dispatch started
- `[POLARIS] COMPLETE <child-id> (commit: <sha>)` — child finished and checkpointed
- `[POLARIS] COMPLETE (cluster-complete)` — all children done, subprocess exits 0

Evaluate the exit to determine the decision:

### DISPATCH (all remaining children) — default

`loop run` dispatches all eligible children serially and exits when done. No per-child handling
by the Foreman is needed. When `loop run` exits 0 with `cluster-complete`, proceed to STOP
(all-done) or DELIVER.

### STOP (blocked)

If `loop run` exits non-zero:
- Report the blocker and unblock condition from the output.
- Do not push. Do not create a PR.
- Resume instruction: resolve the blocker then run `polaris loop run <cluster-id>`.

### STOP (all-done, awaiting delivery)

If `loop run` exits 0 and all children are Done but delivery was not explicitly requested:
- Halt cleanly.
- Report: all children Done, branch name, last commit.
- Provide delivery command: `Use polaris-run on <PARENT-ID>. Finalize delivery.`
- Do not push. Do not create a PR.

### DELIVER

Proceed to step 08 only if:
- All children are Done (confirmed via runtime state).
- The user explicitly requested delivery in this session invocation.

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `status: stopped`
- `current_step_id: 07-decide-continuation`
- `updated_at: <timestamp>`

## Next step

halted (STOP) or 08-closeout-librarian (DELIVER)
