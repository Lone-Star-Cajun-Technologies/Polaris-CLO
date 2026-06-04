---
name: polaris-catalog-step-01
description: Generate run_id, emit run-start telemetry, validate packet, establish work_inventory, and enumerate smartdocs/raw/ for classification.
---

# Step 01 — Orient catalog

## Purpose

Establish bounded execution context before touching any files. Validate the packet,
confirm cognition scope, and enumerate `smartdocs/raw/` for the classification step.

## Actions

### 1.1 Generate run_id

Format: `polaris-catalog-<issue-slug>-<YYYY-MM-DD>-<seq>`
Example: `polaris-catalog-POL-257-2026-06-04-001`

### 1.2 Emit run-start telemetry

First I/O action, before any file access:

```bash
mkdir -p .taskchain_artifacts/polaris-catalog/runs/<run-id>
echo '{"event":"run-start","run_id":"<run-id>","issue_id":"<issue_id>","unattended":<bool>,"timestamp":"<ISO>"}' \
  >> .taskchain_artifacts/polaris-catalog/runs/<run-id>/telemetry.jsonl
```

If this write fails: halt. Do not continue.

### 1.3 Validate packet

Confirm required fields are present:
`run_id`, `issue_id`, `affected_folders`, `work_inventory`, `unattended`,
`allowed_write_paths`, `prohibited_write_paths`, `constraints`

If any required field is missing: halt and report which field is absent.

### 1.4 Build work inventory snapshot

From `packet.work_inventory`, confirm:
- `affected_folders` — folders whose cognition may need updating
- `all_changed_files` — files changed by the completed work
- `child_summaries` — summaries of completed children (if cluster-based)
- `pending_cognition_notes` — pending cognition notes per folder
- `polaris_md_files` — current POLARIS.md paths per folder
- `summary_md_files` — current SUMMARY.md paths per folder

If `affected_folders` is empty: record cognition scope as no-op, continue to step 04 to
still process any docs in `smartdocs/raw/`.

### 1.5 Enumerate smartdocs/raw/

List all files currently in `smartdocs/raw/` (excluding `.provenance.json` sidecars and
hidden files). This is the batch for step 04.

If `smartdocs/raw/` is empty or does not exist: record doc classification as no-op.
Continue — cognition steps may still have work to do.

### 1.6 Restate working context

Summarize in under 10 bullets:
- `run_id` and fresh/resumed
- Bound issue
- Mode: interactive or unattended
- Affected folders for cognition (count)
- Files in `smartdocs/raw/` for classification (count)

## Scope declarations

```yaml
allowed_files:
  - .polaris/skills/polaris-catalog/SKILL.md
  - .polaris/skills/polaris-catalog/chain.md
  - .taskchain_artifacts/polaris-catalog/current-state.json
  - smartdocs/raw/ (enumerate only)
  - packet (read only)
stop_rules:
  - run-start telemetry write fails
  - packet missing required fields
```

## Artifact update

Update `.taskchain_artifacts/polaris-catalog/current-state.json`:
- `run_id`, `issue_id`, `unattended`, `status: orienting`, `current_step_id: 01-orient-catalog`
- `affected_folders`, `raw_files: [...]`, `updated_at: <timestamp>`

## Next step

02-reconcile-polaris-md
