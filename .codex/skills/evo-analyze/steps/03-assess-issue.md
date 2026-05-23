---
name: evo-analyze-step-03-assess-issue
description: Classify the issue into one of five outcomes based on Linear state and repo inspection results.
---

# Step 03 — Assess issue

## Purpose

Determine whether the issue is executable, already satisfied, blocked, ambiguous, or needs splitting.

## Scope declarations

```yaml
allowed_files:
  - Linear issue description and comments
  - affected-code map from step 02
  - direct file snippets needed to verify claims
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-analyze/chain.md
allowed_skills:
  - none
expected_evidence:
  - issue is classified as already-satisfied, needs-child-issues, needs-doctrine-clarification, blocked, or should-be-split
  - evidence supports classification
  - recommended next action recorded
stop_rules:
  - claims cannot be verified
  - acceptance criteria are ambiguous
  - assessment depends on external state unavailable to the run
```
## Actions

Determine one of the following outcomes:

| Outcome | Condition |
|---|---|
| **Already satisfied** | Repo already implements what the issue describes |
| **Needs child issues** | Clear implementation work can be decomposed |
| **Needs doctrine clarification** | Issue is ambiguous or conflicts with existing doctrine |
| **Blocked** | A prerequisite issue or condition is unmet |
| **Should be split** | Issue spans multiple unrelated concerns |

Report the outcome with evidence before advancing to step 04.

## Artifact update

Update `.taskchain_artifacts/evo-analyze/current-state.json`:
- `outcome: <already-satisfied | needs-child-issues | needs-doctrine-clarification | blocked | should-be-split>`
- `last_completed_step: 03-assess-issue`
- `next_step: 04-blocker-check`

## Next step

04-blocker-check
