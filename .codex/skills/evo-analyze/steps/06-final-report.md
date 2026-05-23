---
name: evo-analyze-step-06-final-report
description: Produce the structured audit summary and recommended evo-run command.
---

# Step 06 — Final report

## Purpose

Deliver the complete audit result and recommended run command.

## Scope declarations

```yaml
allowed_files:
  - artifacts from steps 01-05
  - .taskchain_artifacts/evo-analyze/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-analyze/chain.md
allowed_skills:
  - none
expected_evidence:
  - analysis decision summarized
  - created or proposed issues listed
  - blockers and next action reported
stop_rules:
  - artifact state is incomplete
  - analysis has unresolved blocker
  - reported recommendation lacks evidence
```
## Actions

Return a structured summary containing:

1. **Parent issue audited** — ID, title, state
2. **GitNexus status** — fresh or stale (and whether refreshed)
3. **Files / systems inspected** — list of files or execution flows examined (maximum 10 items; summarize remainder as "N additional files")
4. **Findings** — outcome assessment with evidence (maximum 5–10 lines; no raw command output or full file content)
5. **Child issues created / updated** — ID, title, order, and one-line summary for each
6. **Recommended run command**:
   ```text
   Use the evo-run skill. Run EVOC-XXX.
   ```
7. **Remaining risks** — anything uncertain, out of scope, or requiring follow-up

## Artifact update

Update `.taskchain_artifacts/evo-analyze/current-state.json`:
- `status: complete`
- `last_completed_step: 06-final-report`
- `next_step: none`
- `completed_at: <timestamp>`

## Session end

This is the terminal step.
