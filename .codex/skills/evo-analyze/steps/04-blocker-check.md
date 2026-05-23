---
name: evo-analyze-step-04-blocker-check
description: Halt immediately if the issue is blocked; otherwise advance to child issue creation.
---

# Step 04 — Blocker check

## Purpose

Stop forward execution if the issue cannot proceed due to a blocking condition.

## Scope declarations

```yaml
allowed_files:
  - Linear issue relations and labels
  - assessment output from step 03
  - routing/doctrine sources cited by blocker evidence
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-analyze/chain.md
allowed_skills:
  - none
expected_evidence:
  - blockers and unblock conditions listed
  - blocked label/relation needs identified
  - safe continuation decision recorded
stop_rules:
  - blocking dependency exists
  - unblock condition is outside repo control
  - state cannot be updated consistently
```
## Actions

If the outcome from step 03 is `blocked`:

1. Add a comment to the parent issue explaining the unblock condition.
2. Apply a blocked label if available.
3. Do not advance to step 05.
4. Report blocked state and halt.

If the outcome from step 03 is `already-satisfied`, `needs-doctrine-clarification`, or `should-be-split`:

1. Produce the appropriate report describing the finding and recommended next action.
2. Do not create child issues.
3. Halt.

If the outcome is `needs-child-issues`: advance to step 05.

## Artifact update

If halting:
- `status: blocked | halted`
- `last_completed_step: 04-blocker-check`
- `next_step: halted`

If advancing:
- `last_completed_step: 04-blocker-check`
- `next_step: 05-create-child-issues`

## Next step

05-create-child-issues (if `needs-child-issues`), or halted
