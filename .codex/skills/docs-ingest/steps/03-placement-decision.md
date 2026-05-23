---
name: docs-ingest-step-03-placement-decision
description: Verify folder placement, ingest visibility, and doctrine/raw alignment for the current note.
---

# Step 03 — Placement decision

## Purpose

Determine the exact destination path and verify it satisfies all placement rules before any writes happen.

## Scope declarations

```yaml
allowed_files:
  - queued raw note
  - docs/evonotes/**/INSTRUCTIONS.md
  - nearest INSTRUCTIONS.md for destination folder
  - docs/evonotes/spec/**
  - docs/raw/audits-and-issues/**
  - docs/raw/deprecated/**
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - destination path selected
  - routing instructions checked
  - collision check completed
stop_rules:
  - destination conflicts with folder instructions
  - basename collision exists
  - note contains unresolved stale reference
```
## Actions

1. Read `current_note` classification from the artifact notes (set by step 02).

2. Resolve the destination path using this table:

| Classification | Destination |
|---------------|-------------|
| `audit` | `docs/raw/audits-and-issues/<filename>` |
| `deprecated` | `docs/raw/deprecated/<filename>` |
| `duplicate-archive` | `docs/raw/archived/<filename>` |
| `archival` | `docs/raw/archived/<filename>` |
| `implemented` | `docs/evonotes/implemented/<domain>/<filename>` |
| `needs-review` | `docs/evonotes/needs-review/<domain>/<filename>` |

3. For `implemented` and `needs-review`, determine the domain subdirectory:

| Filename or content signals | Domain |
|----------------------------|--------|
| `EVOconnect`, `connect`, inter-app contracts | `connect/` |
| `EVOtraining`, training, coach, plan, workout | `training/` |
| `EVOmind`, Alice, AI, LLM, inference, model | `ai/` |
| HIVE, runtime, device linking, storage | `runtime/` |
| Governance, policy, contract, compliance | `governance/` |
| Unclear domain | Demote to `needs-review/` and flag for human review |

4. Verify placement rules:
   - Raw-class notes (`audit`, `deprecated`, `duplicate-archive`, `archival`) must NOT be placed under `docs/evonotes/`.
   - Doctrine-class notes (`implemented`, `needs-review`) must NOT remain in `docs/raw/`.
   - A note placed in `implemented/` must contain specification-complete signals (not just a draft or exploration).
   - A note with uncertain domain goes to `needs-review/` over a domain-specific `implemented/` path.

5. Verify `INSTRUCTIONS.md` coverage for the resolved destination:
   - Check whether the destination folder itself contains `INSTRUCTIONS.md`.
   - If it does not, record a warning in the artifact notes:
     `WARNING: <dest_dir> has no local INSTRUCTIONS.md; nearest routing instructions are <nearest_or_none>`.
   - This is a warning only. Do not block or reroute the note when `INSTRUCTIONS.md` is missing.
   - If a parent folder has the nearest `INSTRUCTIONS.md`, record that parent path so the final report can show which guidance applied.

6. Verify ingest visibility:
   - Confirm the destination folder exists or can be created.
   - Check whether a file with the same basename already exists at the destination. If it does: record a placement conflict. Doctrine notes (`implemented`, `needs-review`) advance to step 06 (conflict check) before attempting a write. Raw-routed notes proceed directly to step 07 — `mv -n` will skip the write safely and the collision is recorded in the final report.

7. If placement cannot be determined confidently: classify as `blocked`, update artifact, and stop this note's processing.

## Routing after this step

- **Raw-routed notes** (`audit`, `deprecated`, `duplicate-archive`, `archival`): proceed directly to **step 07 (write-or-move)**. Placement collisions for these notes are handled non-destructively by `mv -n` and reported; they do not route through step 06.
- **Doctrine notes** (`implemented`, `needs-review`): proceed to **step 04 (frontmatter normalization)**.

## Shell helpers

```bash
# Check if destination folder exists
[ -d "<DEST_DIR>" ] && echo "exists" || echo "missing"

# Check if basename already exists at destination
[ -f "<DEST_PATH>" ] && echo "collision" || echo "clear"

# Check local and nearest routing instructions for a destination folder.
if [ -f "<DEST_DIR>/INSTRUCTIONS.md" ]; then
  echo "instructions: <DEST_DIR>/INSTRUCTIONS.md"
else
  nearest="$(dir='<DEST_DIR>'; while [ "$dir" != "/" ] && [ "$dir" != "." ]; do [ -f "$dir/INSTRUCTIONS.md" ] && { printf '%s/INSTRUCTIONS.md\n' "$dir"; break; }; dir="$(dirname "$dir")"; done)"
  echo "WARNING: <DEST_DIR> has no local INSTRUCTIONS.md; nearest routing instructions are ${nearest:-none}"
fi
```

## Artifact update

Append to artifact `notes`:
```text
<current_note>: destination = <resolved path>
<current_note>: INSTRUCTIONS.md coverage = local | warning: nearest <path|none>
```

Update fields:
- `last_completed_step: 03-placement-decision`
- `next_step: 04-frontmatter-normalization` (doctrine notes) or `07-write-or-move` (raw-routed notes) or `halted` (blocked)

## Next step

04-frontmatter-normalization (doctrine notes), 07-write-or-move (raw-routed notes), or halted (blocked)
