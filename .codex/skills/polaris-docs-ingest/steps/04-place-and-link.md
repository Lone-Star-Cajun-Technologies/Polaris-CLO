---
name: polaris-docs-ingest-step-04-place-and-link
description: Move classified files to their target authority directories within Polaris-Docs/docs/, write provenance records, and update Polaris map entries.
---

# Step 04 — Place and link

## Purpose

Execute placements for all files that cleared steps 02–03 (approval-required files only after explicit user confirmation). All target paths are within `Polaris-Docs/docs/`. Write provenance. Update the map.

## Placement rules (per file)

1. **Verify target directory** — ensure the target path from step 02 exists. Create it if missing (within `Polaris-Docs/docs/` only).

2. **Check for existing file** at the target path. If a file already exists there: halt for that file and report. Do not overwrite without explicit approval.

3. **Copy** to target path (never move directly — copy first to preserve rollback safety).
   - Always copy the source into `Polaris-Docs/docs/` first.
   - If source is already in `Polaris-Docs/docs/` (reclassification): update front-matter only, no copy.
   - Do not write anything to root `docs/`.
   - After writing provenance (step 5) and after the map update (step 7) succeeds, delete the original source file. If the map update fails, retain the original source.

4. **Doctrine-candidate front-matter** — before placing in `Polaris-Docs/docs/doctrine/candidate/`, inject:
   ```yaml
   status: candidate
   candidate-since: <YYYY-MM-DD>
   source: <original-path>
   ```
   Emit `doctrine-candidate-proposed` telemetry event.

5. **Write provenance record** alongside placed file (`<filename>.provenance.json`):
   ```json
   {
     "currentPath": "<Polaris-Docs/docs/...>",
     "originalPath": "<source path>",
     "ingestedAt": "<ISO timestamp>",
     "ingestRunId": "<run-id>",
     "classifiedAs": "<class>",
     "conflictsDetected": false,
     "staleWarnings": []
   }
   ```

6. **Update Polaris map** — add or update `docs` entry on relevant map nodes:
   - Match code areas by path heuristics or explicit `--area` flag.
   - Link to originating run ID if available in `current-state.json`.
   - Link to related instruction file (`instructionFile` map entry) if one governs the same area.

7. After all files placed: run `npm run polaris -- map update --changed` to synchronize the atlas.

## Hard rules

- All placements land within `Polaris-Docs/docs/`. Never root `docs/`.
- High-authority targets (`doctrine/active/`, `architecture/`, `decisions/`) are BLOCKED without explicit user approval. Halt and report if attempted without it.
- Do not delete source files from `raw/` until provenance record is written and map update succeeds.

## Scope declarations

```yaml
allowed_files:
  - source files (batch)
  - Polaris-Docs/docs/ (target hierarchy — read and write)
  - .polaris/map/index.json (read and write)
  - .polaris/map/file-routes.json (read and write)
expected_evidence:
  - all approved files placed at correct target paths within Polaris-Docs/docs/
  - provenance records written alongside each placed file
  - map updated via npm run polaris -- map update --changed
  - no placements to root docs/ or high-authority paths without approval
stop_rules:
  - target path collision without approval
  - high-authority placement attempted without approval flag
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 04-place-and-link`
- `placed: [{ "file": "<original>", "target": "<placed-path>", "class": "<class>" }]`

## Next step

05-finalize-ingest
