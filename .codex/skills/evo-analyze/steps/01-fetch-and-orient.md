---
name: evo-analyze-step-01-fetch-and-orient
description: Fetch the parent issue from Linear and check GitNexus index freshness in parallel before any inspection.
---

# Step 01 — Fetch and orient

## Purpose

Load the issue state and confirm the repo index is current before any code inspection.

## Scope declarations

```yaml
allowed_files:
  - .codex/skills/evo-analyze/SKILL.md
  - .codex/skills/evo-analyze/chain.md
  - .taskchain_artifacts/evo-analyze/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-analyze/chain.md
allowed_skills:
  - caveman
  - gitnexus
expected_evidence:
  - Linear issue fetched
  - analysis target and parent context recorded
  - routing constraints identified
stop_rules:
  - issue missing or inaccessible
  - issue is not analysis-ready
  - routing conflict blocks analysis
```
## Actions

Run both of the following in the same turn — they are independent:

1. Fetch the Linear issue by ID. Read: title, description, labels, state, priority, existing child issues (id, title, state, order), blocking relationships.
   - If the issue is already Done or Cancelled: report and stop.

2. Read `gitnexus://repo/{name}/context` and check the staleness warning.
   - If stale: run `npx gitnexus analyze` to refresh, then re-read before proceeding.
   - Report staleness and refresh status in the final summary.

## Artifact update

Update `.taskchain_artifacts/evo-analyze/current-state.json`:
- `status: running`
- `parent_issue: <ID — title>`
- `gitnexus_status: fresh | stale | refreshed`
- `completed_steps: [01]`
- `last_completed_step: 01-fetch-and-orient`
- `next_step: 02-map-affected-code`
- `started_at: <timestamp>`

## Next step

02-map-affected-code
