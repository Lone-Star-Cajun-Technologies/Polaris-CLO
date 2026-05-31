---
name: docs-promote-step-01-orient-promote
description: Generate run_id, emit run-start telemetry, load candidate list, confirm canonical target.
---

# Step 01 — Orient promote

## Purpose

Establish bounded promotion context before touching any files. Confirm what to review, confirm the canonical target exists.

## Actions

1. **Generate `run_id`**: `docs-promote-<slug>-<YYYY-MM-DD>-<seq>`
   - Resumed runs: generate new `run_id` first, emit telemetry immediately, then read `current-state.json` for prior `run_id`.

2. **Emit `run-start` telemetry** — first I/O action:
   ```bash
   mkdir -p .taskchain_artifacts/docs-promote/runs/<run-id>
   echo '{"event":"run-start","run_id":"<run-id>","prior_run_id":null,"timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/docs-promote/runs/<run-id>/telemetry.jsonl
   ```
   If this write fails: halt. Do not continue.

3. **Confirm canonical target** — verify `smartdocs/docs/` exists. If not: halt and report.

4. **Restate working context** in under 6 bullets:
   - `run_id` and fresh/resumed
   - Candidates to review (raw/ + doctrine/candidate/)
   - Canonical target confirmed

## Scope

```yaml
allowed_files:
  - .polaris/skills/docs-promote/chain.md
  - .taskchain_artifacts/docs-promote/current-state.json
  - .polaris/map/index.json
stop_rules:
  - run-start telemetry write fails
  - smartdocs/docs/ not found
```

## Artifact update

Update `.taskchain_artifacts/docs-promote/current-state.json`:
- `run_id`, `status: orienting`, `current_step_id: 01-orient-promote`, `updated_at`

Emit `step-complete` for `01-orient-promote`.

## Next step

02-review-candidates
