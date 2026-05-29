---
name: docs-promote-step-04-conflict-surface
description: Run the CLI conflict gate for each candidate and capture the full report. Do not promote yet.
---

# Step 04 — Conflict surface

## Purpose

Surface every conflict before asking for approval. The agent must not approve anything it has not checked. This step is read-only — no files are moved.

## Actions

### For raw specs (`route: spec-promote`)

Run the dry gate for each:

```bash
npm run polaris -- doctrine spec-promote <path>
```

Capture the full stdout. This is the conflict report. Do **not** pass `--approve`.

### For doctrine candidates (`route: doctrine-governance`)

Check front-matter for all required governance fields:
- `doc-type`
- `confidence`
- `recommended-action`
- `overlap-analysis`

If any field is missing or `recommended-action` is not `promote`: mark as `needs-governance-update`. Do not proceed to promotion for this candidate.

### For active docs targeted for deprecation

Confirm the doc's `linkedMapArea` code is gone or marked superseded (from step 03 findings). If relevance is `current`: flag as `deprecation-contested` — surface to user before acting.

### After all candidates checked

Emit `docs-promote-conflict-report` telemetry for each candidate with their conflict status.

## Scope

```yaml
allowed_files:
  - smartdocs/docs/raw/ (read only)
  - smartdocs/docs/doctrine/candidate/ (read only)
  - smartdocs/docs/doctrine/active/ (read only)
  - smartdocs/docs/specs/active/ (read only)
  - .taskchain_artifacts/docs-promote/current-state.json
stop_rules:
  - CLI command exits non-zero unexpectedly (capture output; do not halt batch — record error per candidate)
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 04-conflict-surface`
- Per candidate: `conflict_report: "<captured stdout>"`, `governance_status: ok|needs-governance-update`, `deprecation_status: ok|deprecation-contested`

Emit `step-complete` for `04-conflict-surface`.

## Next step

05-await-approval
