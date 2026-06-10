---
name: docs-promote-step-02-review-candidates
description: List promotion candidates from raw/ and doctrine/candidate/, read provenance sidecars, extract linkedMapArea.
---

# Step 02 — Review candidates

## Purpose

Build the candidate list. Read every co-located provenance sidecar to know what linked code area each doc is associated with.

## Actions

1. **List candidates**:
   - `smartdocs/raw/*.md`
   - `smartdocs/doctrine/candidate/*.md`

2. **For each candidate**, read `<filename>.provenance.json` if present. Extract:
   - `linkedMapArea` — code area this doc covers
   - `classifiedAs` — ingest classification
   - `ingestedAt` — when it was ingested

3. **Categorize** each candidate:
   - `spec-raw` → route: `spec-promote` gate
   - `doctrine-candidate` → route: doctrine governance check
   - No provenance → route: spec-promote gate (default)

4. If no candidates found: emit `step-complete`, update state with `candidates: []`, skip to step 07.

## Scope

```yaml
allowed_files:
  - smartdocs/raw/ (read only)
  - smartdocs/doctrine/candidate/ (read only)
  - .taskchain_artifacts/docs-promote/current-state.json
stop_rules:
  - directory read fails
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 02-review-candidates`
- `candidates: [{ file, classifiedAs, linkedMapArea, route }]`

Emit `step-complete` for `02-review-candidates`.

## Next step

03-read-linked-code
