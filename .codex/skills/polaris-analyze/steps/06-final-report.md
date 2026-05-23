---
name: polaris-analyze-step-06-final-report
description: Produce the structured analysis summary, cluster plan, and recommended polaris-run command.
---

# Step 06 — Final report

## Purpose

Deliver the complete analysis result and the command the operator needs to begin implementation.

## Scope declarations

```yaml
allowed_files:
  - artifacts from steps 01-05
  - .taskchain_artifacts/polaris-analyze/current-state.json
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-analyze/chain.md
expected_evidence:
  - analysis decision summarized
  - clusters.json path confirmed
  - created or updated child issues listed
  - blockers and next action reported
  - recommended run command provided
stop_rules:
  - artifact state is incomplete
  - analysis has unresolved blocker
```

## Actions

Return a structured summary containing:

1. **Parent issue audited** — ID, title, state
2. **GitNexus status** — fresh, stale, or refreshed
3. **Files / systems inspected** — list (max 10; summarize remainder as "N additional files")
4. **Findings** — outcome assessment with evidence (max 5–10 lines; no raw command output)
5. **Clusters plan** — cluster IDs, child issues per cluster, session_types, and dependency order
6. **clusters.json location** — `.polaris/clusters/<source-id>/clusters.json`
7. **Recommended run command**:
   ```bash
   polaris-run <PARENT-ID>
   ```
8. **Remaining risks** — anything uncertain, out of scope, or requiring follow-up

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `status: complete`
- `current_step_id: 06-final-report`
- `completed_at: <timestamp>`
- `updated_at: <timestamp>`

Emit `step-complete` for `06-final-report` to telemetry JSONL.

## Session end

This is the terminal step. Do not continue to polaris-run or any other implementation skill.
