---
name: polaris-run-step-03-select-child
description: Re-fetch the child list from Linear, identify the next unblocked child, and halt on blockers or all-done.
---

# Step 03 — Select child

## Purpose

Identify the correct next child to execute without skipping or misordering.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/polaris-run/current-state.json
  - .polaris/clusters/<cluster-id>/clusters.json
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-run/chain.md
allowed_skills:
  - repo-analysis
expected_evidence:
  - fresh child list fetched from Linear
  - lowest-ordered open child selected
  - blocked child state checked
stop_rules:
  - next child is blocked
  - child ordering is ambiguous
  - all children are Done (route to DELIVER)
```

## Actions

1. **First child of the session**: use the child list fetched in step 01 — do not re-fetch.
2. **Second child and beyond**: re-fetch the full child list from Linear to catch state changes from the prior child.
3. Filter to open children only (exclude Done and Cancelled).
4. If no open children remain:
   - Update artifact: `status: all-children-complete`.
   - End the session. Report: all children Done. Provide the delivery command: `Use polaris-run on <PARENT-ID>. Finalize delivery.`
   - Do not push. Do not create a PR.
5. If clusters.json exists, use it to determine execution order and dependencies. If absent, use the child issue ordering from Linear (lowest-numbered first) as a last-resort fallback — do not improvise ordering from chat reasoning or assumptions.
6. Verify the selected child is not blocked in Linear. If blocked:
   - Run `npm run polaris -- loop abort "<reason>"`.
   - Report blocked state and halt. Do not skip to a later child.
7. Set the selected child as `active_child`.

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `current_step_id: 03-select-child`
- `active_child: <ID>`
- `updated_at: <timestamp>`

If all children complete:
- `status: all-children-complete`
- `current_step_id: awaiting-delivery-request`

Do not emit per-step `step-complete` telemetry. Telemetry is checkpoint-only (`run-start`, `child-dispatched`, child completion/checkpoint events, session end, and blocker/state-repair events).

## Next step

04-execute-child (or halt if all children complete or blocked)
