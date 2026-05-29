---
name: polaris-analyze-step-01-fetch-and-orient
description: Generate run_id, emit run-start telemetry, fetch the Linear issue and check repo-analysis provider availability in parallel.
---

# Step 01 — Fetch and orient

## Purpose

Load the issue state, confirm the repo index is current, and establish governed session context before any inspection.

## Scope declarations

```yaml
allowed_files:
  - .polaris/skills/polaris-analyze/SKILL.md
  - .polaris/skills/polaris-analyze/chain.md
  - .taskchain_artifacts/polaris-analyze/current-state.json
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .polaris/skills/polaris-analyze/chain.md
allowed_skills:
  - repo-analysis
expected_evidence:
  - run_id generated
  - run-start telemetry emitted
  - Linear issue fetched
  - repo-analysis provider status checked
  - analysis target and context recorded
stop_rules:
  - run-start telemetry write fails
  - issue missing or inaccessible
  - issue is already Done or Cancelled
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

2. Run both of the following **in the same turn** (independent, parallelizable):
   - Fetch the Linear issue by ID. Read: title, description, labels, state, priority, existing child issues, blocking relationships.
     - If already Done or Cancelled: report and stop.
   - Check `polaris.config.json` for `providers.repoAnalysis.preferred`.
     - If a provider is configured and available in the session environment:
       - Check provider index freshness. If stale: attempt refresh per provider's documented mechanism.
       - Record `repo_analysis_status: available` in artifact.
     - If not configured or unavailable:
       - Note: no repo-analysis provider available — polaris map query + direct inspection will be used in step 02.
       - Record `repo_analysis_status: not-configured` or `unavailable` accordingly.

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `run_id: <generated>`
- `cluster_id: <issue ID>`
- `skill: polaris-analyze`
- `artifact_dir: ".taskchain_artifacts/polaris-analyze"`
- `status: running`
- `parent_issue: <ID — title>`
- `repo_analysis_status: available | unavailable | not-configured`
- `current_step_id: 01-fetch-and-orient`
- `started_at: <timestamp>`

Emit `step-complete` for `01-fetch-and-orient` to telemetry JSONL.

## Next step

02-map-affected-code
