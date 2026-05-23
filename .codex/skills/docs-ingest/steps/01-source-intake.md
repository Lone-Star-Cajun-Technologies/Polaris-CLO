---
name: docs-ingest-step-01-source-intake
description: Identify all files to process this run, determine ingestion target, note type, and source visibility.
---

# Step 01 — Source intake

## Purpose

Build the bounded input queue for this ingest run before touching any files.

## Scope declarations

```yaml
allowed_files:
  - docs/raw/*.md
  - docs/raw/README.md
  - docs/evonotes/**/* matching queued basenames
  - .taskchain_artifacts/docs-ingest/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - input queue listed
  - basename duplicate check completed
  - note type estimates recorded
  - empty queue stops before artifact initialization
stop_rules:
  - queue is empty
  - named file is unreadable
  - source path is outside docs/raw without explicit request
```
## Actions

1. Determine the ingestion target:
   - If a specific file was named in the invocation: queue that file only.
   - Otherwise: list all `.md` files in `docs/raw/` root, excluding `README.md`.

2. For each file in the queue, record:
   - filename and full path,
   - whether it matches a Linear issue prefix (`EVOS1-`, `EVOC-`, `EVOTRA-`, `EVOMIND-`, `EVOFL-`, or `[A-Z]+-[0-9]+`),
   - whether a file with the same basename already exists anywhere under `docs/evonotes/`,
   - initial note type estimate: `linear-issue` | `doctrine-candidate` | `misc`.

3. Verify source visibility: confirm each file is readable.

4. If the queue is empty: report "no files to process" and stop. Do not initialize a run or write the artifact.

5. Generate a `run_id`: `INGEST-YYYY-MM-DD-HHmm` (e.g. `INGEST-2025-01-27-1430`).

## Shell helpers

```bash
# List queue (excludes README.md)
ls docs/raw/*.md 2>/dev/null | grep -v '/README\.md$'

# Check if a basename exists in evonotes
find docs/evonotes -name "<BASENAME>" 2>/dev/null | head -1
```

## Artifact update

Initialize `.taskchain_artifacts/docs-ingest/current-state.json`:

```yaml
status: running
run_id: <INGEST-YYYY-MM-DD-HHmm>
branch: <current git branch>
queue:
  - <path/to/file1.md>
  - <path/to/file2.md>
current_note: <first file in queue>
processed: []
blocked: []
completed_steps:
  - 01-source-intake
last_completed_step: 01-source-intake
next_step: 02-classify-lifecycle
notes: "Queue built: N files identified"
started_at: <YYYY-MM-DD HH:mm>
completed_at: ~
```

## Next step

02-classify-lifecycle
