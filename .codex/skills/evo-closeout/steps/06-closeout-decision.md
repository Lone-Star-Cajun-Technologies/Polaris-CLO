---
name: evo-closeout-step-06-closeout-decision
description: Choose one of four closeout outcomes based on the verification results; emit the decision before any file action.
---

# Step 06 — Closeout decision

## Purpose

Classify the verification result and state the closeout outcome explicitly before step 07 takes any file action.

## Scope declarations

```yaml
allowed_files:
  - comparison output from step 05
  - closeout decision rules in chain.md
  - .taskchain_artifacts/evo-closeout/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - none
expected_evidence:
  - decision recorded as passed, blocked, partial, or needs human decision
  - risk and follow-up list included
stop_rules:
  - decision is ambiguous
  - blocking gap remains
  - human approval required for partial promotion is missing
```
## Actions

Choose exactly one of the following outcomes:

| Decision | Condition |
|---|---|
| `closeout_passed` | All checks pass, implementation matches spec, GitNexus current, tests documented, no blocking doctrine conflict, no required scope still open |
| `closeout_blocked` | One or more checks fail with a clear remediation path |
| `closeout_partial` | Spec partially satisfied; some criteria met but follow-up required — promote only if explicitly requested |
| `needs_human_decision` | Ambiguous findings requiring human judgment before promoting |

Emit the decision **before** taking any file action. Do not advance to step 07 until the decision is stated.

## Artifact update

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `closeout_decision: <closeout_passed | closeout_blocked | closeout_partial | needs_human_decision>`
- `last_completed_step: 06-closeout-decision`
- `next_step: 07-closeout-action`

## Next step

07-closeout-action
