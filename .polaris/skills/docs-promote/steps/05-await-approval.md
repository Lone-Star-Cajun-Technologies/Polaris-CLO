---
name: docs-promote-step-05-await-approval
description: Present the full conflict report and linked-code findings to the user. Hard stop — do not advance without explicit approval.
---

# Step 05 — Await approval

## Purpose

The user must see everything before anything is promoted. This step never auto-advances.

## Actions

1. **Present the summary table**:

```text
| File | Type | Linked Area | Relevance | Conflicts | Governance | Recommended Action |
```

Fill every column from state. Use `—` only when genuinely unknown.

2. **Print the full conflict report** for any candidate that has one. Never compress or summarize conflict output.

3. **Print governance validation failures** in full for any `needs-governance-update` candidates.

4. **State the recommended action** for each candidate:
   - `promote` — no conflicts, governance ok, code is current
   - `promote-with-override` — conflicts detected; user may approve with understanding
   - `hold` — governance incomplete; needs update before promotion
   - `deprecate` — code area gone or superseded
   - `skip` — unlinked or contested; needs human judgment

5. **Stop and wait.** Do not call any CLI command. Do not write any files. Do not advance to step 06.

6. When the user responds: record their decision per candidate in state as `approved`, `rejected`, or `deferred`. Then advance to step 06.

## Hard rule

**Never call `--approve` in this step. Never move files in this step.**

## Scope

```yaml
allowed_files:
  - .taskchain_artifacts/docs-promote/current-state.json (read then write after user responds)
stop_rules:
  - do not advance without user confirmation
```

## Artifact update

After user responds, update `current-state.json`:
- `current_step_id: 05-await-approval`
- Per candidate: `decision: approved|rejected|deferred`

Emit `docs-promote-approved` or `docs-promote-rejected` telemetry per candidate.
Emit `step-complete` for `05-await-approval`.

## Next step

06-execute-promote-deprecate
