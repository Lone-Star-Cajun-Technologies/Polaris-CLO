---
name: docs-ingest-step-01-orient-ingest
description: Generate run_id, emit run-start telemetry, confirm provider status, load batch file list, and confirm canonical ingest target.
---

# Step 01 — Orient ingest

## Purpose

Establish bounded ingest context before touching any files. Confirm what to process, confirm the canonical target exists, and confirm provider status.

## Scope declarations

```yaml
allowed_files:
  - .polaris/skills/docs-ingest/SKILL.md
  - .polaris/skills/docs-ingest/chain.md
  - .taskchain_artifacts/docs-ingest/current-state.json
  - .polaris/docs-ingest/<cluster-id>.json
  - polaris.config.json
  - .polaris/map/index.json
allowed_routes:
  - CLAUDE.md
  - smartdocs/specs/active/docs-authority-model.md
  - .polaris/skills/docs-ingest/chain.md
allowed_skills:
  - repo-analysis
expected_evidence:
  - run_id generated
  - run-start telemetry emitted
  - batch file list loaded
  - smartdocs/ confirmed present
  - canonical target doctrine stated
stop_rules:
  - run-start telemetry write fails
  - smartdocs/ not found
  - batch cluster file missing or empty
  - no pending clusters and no --file/--batch flags
```

## Actions

0. **Generate `run_id`**:
   - Fresh runs: `docs-ingest-<slug>-<date>-<seq>` (see `chain.md` for format rules).
   - Resumed runs: generate new `run_id` first, emit run-start telemetry immediately (with `prior_run_id: null`), then read `current-state.json` to retrieve prior `run_id` for state continuity.

1. **Emit `run-start` telemetry** — first I/O action, before any file access:
   ```bash
   mkdir -p .taskchain_artifacts/docs-ingest/runs/<run-id>
   echo '{"event":"run-start","run_id":"<run-id>","prior_run_id":"<prior or null>","timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/docs-ingest/runs/<run-id>/telemetry.jsonl
   ```
   If this write fails: halt. Do not continue. For resumed runs, the `prior_run_id` is obtained after this emit by reading `current-state.json`.

2. **Determine ingest source**:
   - `--file <path>`: single file mode. Treat as a batch of one.
   - `--batch <cluster-id>`: read `.polaris/docs-ingest/<cluster-id>.json` for file list.
   - No flags: read `current-state.json` for the next pending cluster ID. If none: halt with "no pending ingest clusters — use --file or --batch, or register clusters first."

3. **Confirm canonical target** — verify `smartdocs/` exists in the repo root.
   - If not found: halt and report. Do not attempt to create it.
   - Assert doctrine: `smartdocs/` is the only valid ingest target. Root `docs/` is legacy. New Smart Docs must not be placed there.
   - Drop zone is `smartdocs/raw/` — the single ingest entry point. There are no sub-raw folders.
   - If any source file already lives in `smartdocs/raw/`: reclassification only — no file move needed in step 04.

4. **Load Polaris map** — read `.polaris/map/index.json` for code-area linking in step 04. If absent, note and proceed (map linking will be skipped in step 04).

5. **Restate working context** in under 8 bullets:
   - `run_id` and fresh/resumed
   - Ingest mode (`--file` / `--batch` / pending-cluster)
   - File list to process
   - Canonical target confirmed: `smartdocs/`
   - Provider status

## Artifact update

Update `.taskchain_artifacts/docs-ingest/current-state.json` (artifact path unchanged — skill identity is `docs-ingest`):
- `run_id`, `status: orienting`, `current_step_id: 01-orient-ingest`
- `files_to_process: [...]`, `updated_at: <timestamp>`

Emit `step-complete` for `01-orient-ingest` to telemetry JSONL.

## Next step

02-classify-batch
