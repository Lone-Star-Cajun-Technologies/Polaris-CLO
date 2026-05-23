---
name: evo-closeout-step-01-fetch-and-orient
description: Fetch Linear state and check GitNexus freshness in parallel before any verification work.
---

# Step 01 — Fetch and orient

## Purpose

Load the full issue state and confirm the repo index is current before verification begins.

## Scope declarations

```yaml
allowed_files:
  - .codex/skills/evo-closeout/SKILL.md
  - .codex/skills/evo-closeout/chain.md
  - .taskchain_artifacts/evo-closeout/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - caveman
  - gitnexus
expected_evidence:
  - target issue/cluster fetched
  - linked delivery state identified
  - closeout scope bounded
stop_rules:
  - target missing or inaccessible
  - delivery state is not ready for closeout
  - closeout target conflicts with routing doctrine
```
## Actions

Run both of the following in the same turn — they are independent:

1. Fetch the parent issue: title, description, state, labels, priority.
   Fetch all child issues: id, title, state, execution order, linked PRs, linked commits, comments.
   - If the parent is not Done or Cancelled: report the open state and ask the user whether to proceed. Do not auto-close an in-progress cluster.

2. Read `gitnexus://repo/git-fit/context` and check staleness.
   - If stale: run `npx gitnexus analyze` before proceeding.
   - Report staleness and refresh status in the final summary.

## Artifact update

**If parent is Done or Cancelled, OR user has explicitly confirmed proceeding:**

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `status: running`
- `parent_issue: <ID — title>`
- `gitnexus_status: fresh | stale | refreshed`
- `completed_steps: [01]`
- `last_completed_step: 01-fetch-and-orient`
- `next_step: 02-locate-planning-specs`
- `started_at: <timestamp>`

**If parent is still open and no user confirmation received:**

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `status: waiting_for_confirmation`
- `parent_issue: <ID — title>`
- `gitnexus_status: fresh | stale | refreshed`
- `started_at: <timestamp>`

Do NOT update `completed_steps`, `last_completed_step`, or `next_step`.

## Next step

02-locate-planning-specs (only after parent is closed or user confirms)
