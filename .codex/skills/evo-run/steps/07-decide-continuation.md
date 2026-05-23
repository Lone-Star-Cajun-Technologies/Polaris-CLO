---
name: evo-run-step-07-decide-continuation
description: Evaluate session health and route to CONTINUE, STOP, or DELIVER based on token risk, validation noise, and child completion state.
---

# Step 07 — Decide continuation

## Purpose

Evaluate session health and choose the correct next action: continue, stop, or deliver.

## Evaluation criteria

Assess each of the following before deciding:

| Factor | Stop signal (measurable threshold) |
|--------|-------------------------------------|
| Children executed this session | ≥ 4 children completed (`context_budget.children_completed ≥ 4`) |
| Last child file count | Last child touched > 20 files (`context_budget.last_child_files_touched > 20`) |
| Session file count | Total files touched this session > 50 (`context_budget.files_touched_total > 50`) |
| Validation noise | Any single validation check output exceeds 20 lines, or output includes content from outside the child's changed files |
| Repo dirtiness | Uncommitted changes outside child scope |
| Scope growth | Discovered work outside the parent cluster |

## Decision rules

**CONTINUE** — proceed to step 03 if ALL of the following hold:
- Fewer than 4 children completed this session (`context_budget.children_completed < 4`).
- Last child touched ≤ 20 files (`context_budget.last_child_files_touched ≤ 20`).
- Total files touched this session ≤ 50 (`context_budget.files_touched_total ≤ 50`).
- No validation check produced more than 20 lines of output.
- No unrelated cleanup pressure has accumulated.
- Remaining children are within the same parent cluster.

**STOP (token/context risk)** — halt cleanly and report if ANY stop signal is present:
- Report: completed child ID, commit hash (if committed), validation result, next open child ID and title.
- Provide the command to resume: `Use evo-run on <PARENT-ID>. Continue the cluster from Linear state.`
- Do not push. Do not create a PR.

**DELIVER** — proceed to step 08 only if:
- All children are Done (confirmed via Linear state, not assumption).
- The user has explicitly requested final delivery in this session invocation.

**STOP (all-done, awaiting delivery)** — if all children are Done but final delivery was not explicitly requested in the session invocation: halt cleanly. Report completion status (all children Done, branch name, last commit). Provide the delivery command: `Use evo-run on <PARENT-ID>. Finalize delivery, push the branch, and create the draft PR.` Do not push. Do not create a PR.

## Scope declarations

```yaml
allowed_files:
  - .taskchain_artifacts/evo-run/current-state.json
  - .taskchain_artifacts/evo-run/runs/*.jsonl
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - caveman-compress
expected_evidence:
  - fresh child list and parent state evaluated
  - CONTINUE, STOP, or DELIVER decision recorded
  - resume command recorded when stopping
stop_rules:
  - blocked child remains open
  - context risk requires handoff
  - all children complete but delivery was not requested
```
## Artifact update

After deciding, update `.taskchain_artifacts/evo-run/current-state.json`:
- `status: <continuing | stopped | delivering>`
- `current_step_id: 07-decide-continuation`
- `updated_at: <timestamp>`

## Next step

03-select-child (CONTINUE), halted (STOP), or 08-final-delivery (DELIVER)
