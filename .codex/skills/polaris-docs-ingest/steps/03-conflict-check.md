---
name: polaris-docs-ingest-step-03-conflict-check
description: Compare each classified file against doctrine/active/ and specs/active/ to detect contradictions or overlapping scope before placement.
---

# Step 03 — Conflict check

## Purpose

Prevent silent contradiction of active doctrine or specs. Every conflict must be surfaced. None may be suppressed.

## Check sequence (per file)

1. **Active doctrine check** — compare document assertions against all files in `smartdocs/docs/doctrine/active/`.
   - Direct contradiction (document asserts X; existing active doctrine asserts not-X) → **HALT**. Report conflict. Do not continue until user resolves.

2. **Active spec overlap** — compare document scope against `smartdocs/docs/specs/active/`.
   - Overlapping scope (two specs govern the same surface) → flag as candidate supersede. Surface recommendation to user. Do not halt; continue with warning.

3. **Stale assumption check** — scan for references to APIs, file paths, commands, or module names that no longer exist (cross-reference `.polaris/map/index.json`).
   - Stale assumption found → record in `current-state.json` under `stale_assumptions` and emit `docs-ingest-stale-assumption` telemetry. Do not halt. Do not mutate source files.

4. **No conflicts** → proceed to step 04.

## Halt behavior

On direct doctrine contradiction:

```text
**BLOCKED — doctrine conflict detected**
File: <source path>
Conflicts with: <smartdocs/docs/doctrine/active/<file>>
Assertion: <what conflicts>
Required: user must resolve before ingest can proceed for this file.
```

Do not advance to step 04 for the conflicting file until resolved or reclassified. Non-conflicting files in the same batch may proceed.

## Scope declarations

```yaml
allowed_files:
  - source files from batch (read only)
  - smartdocs/docs/doctrine/active/ (read only)
  - smartdocs/docs/specs/active/ (read only)
  - .polaris/map/index.json (read only)
expected_evidence:
  - all files checked against active doctrine and specs
  - direct contradictions halted and reported
  - stale assumptions recorded in current-state.json
  - overlaps surfaced with candidate-supersede recommendation
stop_rules:
  - direct doctrine contradiction (file held; batch may continue)
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 03-conflict-check`
- `conflicts: [{ "file": "<path>", "type": "contradiction|overlap|stale", "detail": "..." }]`

Emit `docs-ingest-conflict-detected` for each conflict found.

## Next step

04-place-and-link
