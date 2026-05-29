---
name: polaris-docs-ingest-step-04-place-and-link
description: Move classified files to their target authority directories within smartdocs/docs/, write provenance records, and update Polaris map entries.
---

# Step 04 — Place and link

## Purpose

Execute placements for all files that cleared steps 02–03 (approval-required files only after explicit user confirmation). All target paths are within `smartdocs/docs/`. Write provenance. Update the map.

## Placement rules (per file)

1. **Verify target directory** — ensure the target path from step 02 exists. Create it if missing (within `smartdocs/docs/` only).

2. **Check for existing file** at the target path. If a file already exists there: halt for that file and report. Do not overwrite without explicit approval.

3. **Use the Polaris CLI** — do not move files manually. The CLI handles provenance, map updates, and duplicate detection:
   - `spec-raw`: `npm run polaris -- docs ingest --file <path>` (CLI routes to `smartdocs/docs/raw/`; if source is already there, no move occurs)
   - `doctrine-candidate`: `npm run polaris -- doctrine draft <path>`
   - All other classifications: use `npm run polaris -- docs ingest --file <path>`
   - If source is already in `smartdocs/docs/` (reclassification): update front-matter only, re-run ingest to refresh provenance.
   - Do not write anything to root `docs/`.

4. **Doctrine-candidate front-matter** — the CLI injects this automatically via `doctrine draft`. For reference, the added fields are:
   ```yaml
   status: candidate
   candidate-since: <YYYY-MM-DD>
   source: <original-path>
   ```
   Emit `doctrine-candidate-proposed` telemetry event.

5. **Provenance record** — the CLI writes `<filename>.provenance.json` alongside the placed file automatically. Verify it exists after placement.

6. **Update Polaris map** — the CLI calls `updateMapEntry` internally. After the batch: run `npm run polaris -- map update --changed` to synchronize the atlas.

## Hard rules

- All placements land within `smartdocs/docs/`. Never root `docs/`.
- High-authority targets (`doctrine/active/`, `specs/active/`, `architecture/`, `decisions/`) are BLOCKED without explicit user approval. Halt and report if attempted without it.
- The CLI handles file moves — do not use `mv` or `cp` directly on files under `smartdocs/docs/`.

## Scope declarations

```yaml
allowed_files:
  - source files (batch)
  - smartdocs/docs/ (target hierarchy — read and write via CLI)
  - .polaris/map/index.json (read and write)
  - .polaris/map/file-routes.json (read and write)
expected_evidence:
  - all approved files placed at correct target paths within smartdocs/docs/
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
