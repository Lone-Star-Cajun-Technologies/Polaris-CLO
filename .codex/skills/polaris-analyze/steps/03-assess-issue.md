---
name: polaris-analyze-step-03-assess-issue
description: Classify the issue into one of five outcomes based on Linear state and repo inspection results.
---

# Step 03 — Assess issue

## Purpose

Determine whether the issue is executable, already satisfied, blocked, ambiguous, or needs splitting before planning clusters.

## Scope declarations

```yaml
allowed_files:
  - Linear issue description and comments
  - affected-code map from step 02
  - direct file snippets needed to verify claims
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .codex/skills/polaris-analyze/chain.md
expected_evidence:
  - issue classified as one of five outcomes
  - evidence supports classification
  - recommended next action recorded
stop_rules:
  - claims cannot be verified
  - acceptance criteria are ambiguous without user input
  - assessment depends on external state unavailable to this run
```

## Actions

Determine one of the following outcomes:

| Outcome | Condition |
|---|---|
| **Already satisfied** | Repo already implements what the issue describes |
| **Needs cluster plan** | Clear implementation work can be decomposed into executable clusters |
| **Needs doctrine clarification** | Issue is ambiguous or conflicts with existing architecture |
| **Blocked** | A prerequisite issue or condition is unmet |
| **Should be split** | Issue spans multiple unrelated concerns |

Report the outcome with evidence before advancing to step 04.

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `outcome: <already-satisfied | needs-cluster-plan | needs-doctrine-clarification | blocked | should-be-split>`
- `current_step_id: 03-assess-issue`
- `updated_at: <timestamp>`

Emit `step-complete` for `03-assess-issue` to telemetry JSONL.

## Next step

04-blocker-check
