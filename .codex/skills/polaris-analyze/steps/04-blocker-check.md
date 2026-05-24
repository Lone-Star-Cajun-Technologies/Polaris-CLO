---
name: polaris-analyze-step-04-blocker-check
description: Halt if the issue is blocked or non-executable; advance to cluster planning only if outcome is needs-cluster-plan.
---

# Step 04 — Blocker check

## Purpose

Stop forward execution if the issue cannot proceed. Only `needs-cluster-plan` advances to step 05.

## Scope declarations

```yaml
allowed_files:
  - Linear issue relations and labels
  - assessment output from step 03
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-analyze/chain.md
expected_evidence:
  - blockers and unblock conditions listed
  - safe continuation decision recorded
stop_rules:
  - blocking dependency exists
  - outcome is not needs-cluster-plan
```

## Actions

**If outcome is `blocked`:**
1. Add a comment to the parent issue explaining the unblock condition.
2. Apply a blocked label if available.
3. Halt. Do not advance to step 05.

**If outcome is `already-satisfied`, `needs-doctrine-clarification`, or `should-be-split`:**
1. Produce the appropriate report describing the finding and recommended next action.
2. Do not create cluster plans or child issues.
3. Halt.

**If outcome is `needs-cluster-plan`:** advance to step 05.

## Artifact update

If halting:
- `status: blocked | halted`
- `current_step_id: 04-blocker-check`
- `next_step: halted`
- `updated_at: <timestamp>`

If advancing:
- `current_step_id: 04-blocker-check`
- `next_step: 05-create-cluster-plan`
- `updated_at: <timestamp>`

Emit `step-complete` for `04-blocker-check` to telemetry JSONL.

## Next step

05-create-cluster-plan (if `needs-cluster-plan`), or halted
