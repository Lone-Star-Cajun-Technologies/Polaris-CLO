---
name: docs-ingest-step-07-write-or-move
description: Execute the bounded write or move for the current note, update artifact state, and decide whether to continue to the next note or advance to global verification.
---

# Step 07 — Write or move

## Purpose

Execute the bounded write or move determined by steps 02–06, then decide whether the run continues.

## Scope declarations

```yaml
allowed_files:
  - queued raw note
  - destination path selected in step 03
  - archive/deprecated/audits destination paths
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
  - file written or moved exactly once
  - source archive action recorded
  - no unrelated docs touched
stop_rules:
  - destination parent missing unexpectedly
  - write would overwrite existing file
  - move would lose source provenance
```
## Actions

### Part A — Execute the bounded operation

1. Read `current_note` classification and resolved destination from the artifact notes.

2. Read any `INSTRUCTIONS.md` coverage warning recorded by step 03 for this note. Preserve it through the processed entry and final report; warning presence must not block the write or move.

3. Execute the appropriate operation:

| Classification | Operation |
|---------------|-----------|
| `audit` | `mv -n <current_note> docs/raw/audits-and-issues/<filename>` |
| `deprecated` | `mv -n <current_note> docs/raw/deprecated/<filename>` |
| `duplicate-archive` | `mv -n <current_note> docs/raw/archived/<filename>` |
| `archival` | `mv -n <current_note> docs/raw/archived/<filename>` |
| `implemented` | Write normalized content to destination; archive original with `mv -n <current_note> docs/raw/archived/<filename>` |
| `needs-review` | Write normalized content to destination; archive original with `mv -n <current_note> docs/raw/archived/<filename>` |

4. For doctrine notes (`implemented`, `needs-review`): write the content that was assembled across steps 04–05 (normalized frontmatter + body + YAML backlinks) to the destination path. Do not write raw content that failed normalization.

5. If the destination folder does not exist: create it with `mkdir -p <dest_dir>`.

6. **Do not overwrite** an existing file at the destination without explicit conflict resolution from step 06. If step 06 did not clear the collision, abort this write and record the failure.

7. After writing or moving: update the folder README traversal map if the note was promoted to `docs/evonotes/`:
   - Read `<dest_dir>/README.md`.
   - Add a new row to the Traversal Map table: `| <concept from filename> | [[<basename-without-extension>]] | <note_type> |`
   - If no `README.md` exists in the destination folder: create one from `docs/evonotes/_templates/_TEMPLATE - Index README.md`.
   - Do not add entries to the "Canonical Entry Points" section automatically.

### Part B — Avoid broad rewrites

- Write only the current note and update only the directly affected folder README.
- Do not refactor other notes in the folder.
- Do not update READMEs in parent or sibling folders unless the note is a new subfolder index.
- Do not rename existing files.

### Part C — Update queue and decide continuation

8. Mark the current note as processed in the artifact:

```yaml
processed:
  - note: <current_note_path>
    classification: <value>
    disposition: <canonized | moved | archived | audit-routed | deprecated-routed>
    destination: <final path>
    instructions_warning: <warning text or none>
```

9. Remove `current_note` from the `queue` array in the artifact.

10. **Decide continuation**:
   - If `queue` is non-empty: set `current_note` to the next file in the queue, set `next_step: 02-classify-lifecycle`. → **NEXT_NOTE**
   - If `queue` is empty: set `current_note: ~`, set `next_step: 08-index-update`. → **ALL_NOTES_DONE**
   - If token/context risk is high: set `status: stopped`, record queue remainder, provide resume command. → **STOP**

## Artifact update

After the write/move and continuation decision:

```yaml
processed:
  - <append this note's entry>
queue: <remaining items>
current_note: <next note or ~>
last_completed_step: 07-write-or-move
next_step: <02-classify-lifecycle | 08-index-update | halted>
```

## Resume command

If stopping due to token/context risk:

```text
Use docs-ingest. Resume from .taskchain_artifacts/docs-ingest/current-state.json.
```

## Next step

02-classify-lifecycle (NEXT_NOTE), 08-index-update (ALL_NOTES_DONE), or halted (STOP/BLOCKED)
