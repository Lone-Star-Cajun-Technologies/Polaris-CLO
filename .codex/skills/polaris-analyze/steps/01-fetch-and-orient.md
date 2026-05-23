---
name: polaris-analyze-step-01-fetch-and-orient
description: Generate run_id, emit run-start telemetry, activate caveman-lite, fetch the Linear issue and GitNexus freshness in parallel.
---

# Step 01 — Fetch and orient

## Purpose

Load the issue state, confirm the repo index is current, and establish governed session context before any inspection.

## Scope declarations

```yaml
allowed_files:
  - .codex/skills/polaris-analyze/SKILL.md
  - .codex/skills/polaris-analyze/chain.md
  - .taskchain_artifacts/polaris-analyze/current-state.json
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .codex/skills/polaris-analyze/chain.md
allowed_skills:
  - caveman
  - gitnexus
expected_evidence:
  - run_id generated
  - run-start telemetry emitted
  - caveman-lite active
  - Linear issue fetched
  - GitNexus freshness checked
  - analysis target and context recorded
stop_rules:
  - run-start telemetry write fails
  - issue missing or inaccessible
  - issue is already Done or Cancelled
  - caveman activation fails (note and continue — lite mode is advisory)
```

## Actions

0. **Generate `run_id`** — pure local computation:
   - Format: `polaris-analyze-<slug>-<date>-<seq>` (see `chain.md` for format rules)
   - For resumed sessions, read the prior `run_id` from current-state.json first.

1. **Emit `run-start` telemetry** — first I/O action:
   ```bash
   mkdir -p .taskchain_artifacts/polaris-analyze/runs/<run-id>
   echo '{"event":"run-start","run_id":"<run-id>","prior_run_id":"<prior or null>","timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/polaris-analyze/runs/<run-id>/telemetry.jsonl
   ```
   If this write fails: halt.

2. **Activate caveman-lite** per `linked-skills/caveman.md`. If not installed, proceed and note the gap.

3. Run both of the following **in the same turn** (independent, parallelizable):
   - Fetch the Linear issue by ID. Read: title, description, labels, state, priority, existing child issues, blocking relationships.
     - If already Done or Cancelled: report and stop.
   - Read `gitnexus://repo/{name}/context` and check the staleness warning.
     - If stale: run `npx gitnexus analyze` to refresh, then re-read.

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `run_id: <generated>`
- `cluster_id: <issue ID>`
- `skill: polaris-analyze`
- `artifact_dir: ".taskchain_artifacts/polaris-analyze"`
- `status: running`
- `parent_issue: <ID — title>`
- `gitnexus_status: fresh | stale | refreshed`
- `current_step_id: 01-fetch-and-orient`
- `started_at: <timestamp>`

Emit `step-complete` for `01-fetch-and-orient` to telemetry JSONL.

## Next step

02-map-affected-code
