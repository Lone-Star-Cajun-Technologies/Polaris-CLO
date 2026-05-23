---
name: evo-run-step-01-orient-cluster
description: Fetch parent and children from Linear, confirm the cluster is executable, and restate bounded session context before any code changes.
---

# Step 01 — Orient cluster

## Purpose

Establish the bounded working context for this session before touching any code.

## Scope declarations

```yaml
allowed_files:
  - .codex/skills/evo-run/SKILL.md
  - .codex/skills/evo-run/chain.md
  - .taskchain_artifacts/evo-run/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - caveman
  - gitnexus
expected_evidence:
  - Linear parent issue fetched
  - Linear child list fetched by parentId
  - blocker and prerequisite status checked
  - bounded session context restated
stop_rules:
  - caveman-full not invoked or not confirmed active before Linear access or branch preparation
  - parent issue missing or inaccessible
  - parent or selected child is blocked
  - issue shape conflicts with governed execution rules
```
## Actions

0. **Generate run_id** as the first micro-action of the session — pure local computation, no I/O.
   - Format: `run-YYYY-MM-DD-NNN` where NNN is zero-padded sequential per day.
   - Determine `run_source`: `fresh` for a new run, `resumed` if continuing from a prior `run_id`, `reopened` if the issue was previously Done.
   - Determine `related_run_id`: the prior `run_id` if this is a resumed or reopened run, else null.
   - Create `.taskchain_artifacts/evo-run/runs/[run-id].jsonl` and emit `run-start` as its first and only event at this point. Format: see `.evo/run-state/event-catalog.md`.
1. **Activate caveman-full** immediately after run-start emission — before any Linear access, branch work, or file reads.
   - Emit `compression-mode-started` to `.taskchain_artifacts/evo-run/runs/[run-id].jsonl`.
   - Invoke the Skill tool with `skill: caveman`.
   - Confirm full mode is active (the skill body must be loaded and applied, not just the linkage orientation file).
   - If skill invocation fails or cannot be confirmed active: emit `compression-mode-failed` to `.taskchain_artifacts/evo-run/runs/[run-id].jsonl`, then halt. Do not fetch from Linear.
   - Emit `compression-mode-validated` to `.taskchain_artifacts/evo-run/runs/[run-id].jsonl`.
   - Reading `linked-skills/caveman.md` does NOT satisfy this requirement.
2. Fetch the parent issue AND all child issues from Linear MCP in two sequential tool calls within the same agent turn (get parent, then get children by parent ID).
3. Confirm this is a valid, executable parent cluster (has children, not ambiguous, not blocked at parent level).
4. If the parent is ambiguous, missing children, or not executable: stop and use evo-plan instead.
5. Restate the working context in under 10 bullets covering:
   - `run_id` and `run_source`
   - Parent issue ID and title
   - Branch name (create or reuse)
   - Total children count
   - Open children (IDs and titles, lowest first)
   - Any blockers visible at this stage
   - Execution boundary (one parent cluster, this session)
6. Do not open files, read code, or run commands at this step (other than the telemetry append).

## Artifact update

After completing, update `.taskchain_artifacts/evo-run/current-state.json`:

- `run_id`, `run_source`, `parent_run_id`, `related_run_id` set from generation
- `status: orienting`
- `current_step_id: 01-orient-cluster`
- `compression_mode: "caveman-full"`
- `compression_mode_active: true`
- `updated_at: <timestamp>`

Emit `step-complete` for `01-orient-cluster` to `.taskchain_artifacts/evo-run/runs/[run-id].jsonl`. Format: see `.evo/run-state/event-catalog.md`.

## Next step

02-prepare-branch
