---
name: docs-ingest-step-04-place-and-link
description: Move classified files to their target authority directories within smartdocs/, write provenance records, and update Polaris map entries.
---

# Step 04 — Place and link

## Purpose

Execute placements for all files that cleared steps 02–03. High-confidence, non-approval-required files are placed automatically. Approval-required files wait for explicit user confirmation. Low-confidence files land in `smartdocs/raw/`. All target paths are within `smartdocs/`. Write provenance. Update the map.

## Placement rules (per file)

1. **Check `auto_place` flag** — read from `current-state.json` classifications:
   - `auto_place: true` (high confidence, non-approval-required) → proceed immediately
   - `auto_place: false`, `approval_required: false` (low confidence) → target is `smartdocs/raw/`; proceed immediately
   - `approval_required: true` → hold until user confirms

2. **Verify target directory** — ensure the target path from step 02 exists. Create it if missing (within `smartdocs/` only).

3. **Check for existing file** at the target path. If a file already exists there: halt for that file and report. Do not overwrite without explicit approval.

4. **Use the Polaris CLI** — do not move files manually. The CLI handles provenance, map updates, and duplicate detection:
   - `spec-raw` or low-confidence fallback: `polaris docs ingest --file <path>` (CLI routes to `smartdocs/raw/`; if source is already there, no move occurs)
   - `doctrine-candidate`: `polaris doctrine draft <path>`
   - All other classifications: use `polaris docs ingest --file <path>`
   - If source is already in `smartdocs/` (reclassification): update front-matter only, re-run ingest to refresh provenance.
   - Do not write anything to root `docs/`.

5. **Doctrine-candidate front-matter** — the CLI injects this automatically via `doctrine draft`. For reference, the added fields are:
   ```yaml
   status: candidate
   candidate-since: <YYYY-MM-DD>
   source: <original-path>
   ```
   Emit `doctrine-candidate-proposed` telemetry event.

6. **Provenance record** — the CLI writes `<filename>.provenance.json` alongside the placed file automatically. Verify it exists after placement.

7. **Update Polaris map** — the CLI calls `updateMapEntry` internally. After the batch: run `polaris map update --changed` to synchronize the atlas.

## Hard rules

- All placements land within `smartdocs/`. Never root `docs/`.
- High-authority targets (`doctrine/active/`, `specs/active/`, `architecture/`, `decisions/`) are BLOCKED without explicit user approval. Halt and report if attempted without it.
- Low-confidence files always land in `smartdocs/raw/` regardless of inferred class.
- The CLI handles file moves — do not use `mv` or `cp` directly on files under `smartdocs/`. Manual moves bypass `.smartdocignore` enforcement.
- If the CLI rejects a file as ignored (e.g., `POLARIS.md`, `SUMMARY.md`, `README.md`), do NOT move it manually. Leave it in `raw/` and note it in the step 05 summary as ineligible.

## Scope declarations

```yaml
allowed_files:
  - source files (batch)
  - smartdocs/ (target hierarchy — read and write via CLI)
  - .polaris/map/index.json (read and write)
  - .polaris/map/file-routes.json (read and write)
expected_evidence:
  - all approved files placed at correct target paths within smartdocs/
  - provenance records written alongside each placed file
  - map updated via polaris map update --changed
  - low-confidence files confirmed routed to smartdocs/raw/
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
