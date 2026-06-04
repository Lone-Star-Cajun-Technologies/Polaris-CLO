---
name: polaris-reconcile-step-01
description: Generate run_id, emit run-start telemetry, load packet, validate schema, and establish work_inventory.
---

# Step 01 — Orient reconcile

## Purpose

Establish bounded execution context before touching any files. Validate the packet,
confirm which folders are in scope, and build the work inventory.

## Actions

### 1.1 Generate run_id

Format: `polaris-reconcile-<issue-slug>-<YYYY-MM-DD>-<seq>`
Example: `polaris-reconcile-POL-257-2026-06-04-001`

### 1.2 Emit run-start telemetry

First I/O action, before any file access:

```bash
mkdir -p .taskchain_artifacts/polaris-reconcile/runs/<run-id>
echo '{"event":"run-start","run_id":"<run-id>","issue_id":"<issue_id>","timestamp":"<ISO>"}' \
  >> .taskchain_artifacts/polaris-reconcile/runs/<run-id>/telemetry.jsonl
```

If this write fails: halt. Do not continue.

### 1.3 Validate packet

Confirm the packet contains all required fields:
`run_id`, `issue_id`, `affected_folders`, `work_inventory`, `allowed_write_paths`,
`prohibited_write_paths`, `constraints`

If any required field is missing: halt and report which field is absent.

### 1.4 Build work inventory snapshot

From `packet.work_inventory`, confirm:
- `affected_folders` — list of folder paths whose cognition may need updating
- `all_changed_files` — files changed by the completed work
- `child_summaries` — summaries of completed children (if cluster-based)
- `pending_cognition_notes` — any pending cognition notes per folder
- `polaris_md_files` — current POLARIS.md paths per folder
- `summary_md_files` — current SUMMARY.md paths per folder

If `affected_folders` is empty: record as no-op, skip to step 04.

### 1.5 Restate working context

Summarize in under 8 bullets:
- `run_id` and fresh/resumed
- Bound issue
- Affected folders (count and paths)
- `allowed_write_paths` count
- `prohibited_write_paths` count

## Scope declarations

```yaml
allowed_files:
  - .polaris/skills/polaris-reconcile/SKILL.md
  - .polaris/skills/polaris-reconcile/chain.md
  - .taskchain_artifacts/polaris-reconcile/current-state.json
  - packet (read only)
stop_rules:
  - run-start telemetry write fails
  - packet missing required fields
```

## Artifact update

Update `.taskchain_artifacts/polaris-reconcile/current-state.json`:
- `run_id`, `issue_id`, `status: orienting`, `current_step_id: 01-orient-reconcile`
- `affected_folders`, `updated_at: <timestamp>`

## Next step

02-reconcile-polaris-md
