---
name: docs-ingest-step-05-backlink-normalization
description: Detect inline and YAML backlinks, promote critical inline backlinks into YAML, verify machine-readable graph connectivity, and detect orphaned notes.
---

# Step 05 — Backlink normalization

## Purpose

Ensure the current note is machine-traversable via YAML backlinks, and that related notes in `docs/evonotes/` point back to it.

YAML backlinks are the canonical machine-readable graph links. Inline wiki-links are supporting context only.

## Backlink format

The canonical YAML backlink format is:

```yaml
related_notes:
  - "[[Note Title Without Extension]]"
  - "[[Another Related Note]]"
```

Inline wiki-links (`[[Note]]` in body text) may remain for readability but must not be the sole backlink mechanism.

## Scope declarations

```yaml
allowed_files:
  - destination note draft
  - docs/evonotes/**/*.md selected by related concepts
  - MOC/index files related to note domain
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - related_notes populated
  - reciprocal backlinks identified or updated
  - missing backlink rationale recorded
stop_rules:
  - related note says not to update
  - related note cannot be safely identified
  - backlink update would broaden scope
```
## Actions

### Part A — Outbound backlinks (this note → related notes)

1. Read the current note's body for all inline `[[wiki-link]]` references.
2. Identify which inline links represent critical graph relationships (parent doctrine, sibling specs, domain MOC).
3. Promote critical inline links into the `related_notes` YAML array if not already present.
4. Non-critical inline links (incidental references, examples) may remain inline-only.

### Part B — Inbound backlinks (related notes → this note)

5. Infer the note's primary concepts from: filename, title heading, `domain_lifecycle`, note headings, and key body terms.

6. Search `docs/evonotes/` for related active notes using those concepts:

```bash
# Replace CONCEPT1, CONCEPT2 with note-specific terms
rg -l "CONCEPT1|CONCEPT2" docs/evonotes --glob '*.md'
```

7. For each confidently related note found, add a `[[<this-note-basename-without-extension>]]` wiki-link:
   - Prefer updating the domain MOC first.
   - Then the closest topic MOC or sibling doctrine note.
   - Then direct parent spec notes.
   - Add the link to the related note's `related_notes` YAML array (required for canonical machine-readable graph integrity). Optionally mirror it in an existing "Related notes" or "Related doctrine" body section for reader context.

8. Add reciprocal links from this note back to the most important related notes (update `related_notes` YAML).

9. Verify the current note has at least one inbound link from a non-README note:

```bash
BASE="<note-basename-without-extension>"
rg -lF "[[$BASE]]" docs/evonotes --glob '!**/README.md' 2>/dev/null | grep -v "^<current_note_path>$"
```

10. If no related note can be confidently identified: mark this note `BACKLINK-BLOCKED` in the artifact. Do not add speculative links. Report and continue to step 06 (do not halt the run).

### Part C — Orphan sweep (runs every ingest, even when no new notes were canonized)

11. Find all notes in `docs/evonotes/implemented/` and `docs/evonotes/needs-review/` with zero inbound wiki-links from non-README notes:

```bash
find docs/evonotes/implemented docs/evonotes/needs-review -name "*.md" -print0 \
  | while IFS= read -r -d '' note; do
  [[ "$note" =~ /README\.md$ ]] && continue
  [[ "$(basename "$note")" == _* ]] && continue
  base="$(basename "$note" .md)"
  count=$(
    {
      rg -lF "[[$base]]"  docs/evonotes --glob '!**/README.md' 2>/dev/null
      rg -lF "[[$base|"   docs/evonotes --glob '!**/README.md' 2>/dev/null
      rg -lF "[[$base#"   docs/evonotes --glob '!**/README.md' 2>/dev/null
    } | sort -u | grep -vFx "$note" | wc -l
  )
  [ "$count" -eq 0 ] && echo "UNLINKED: $note"
done
```

12. For each `UNLINKED` note found: follow the same process as Part B steps 5–9 to add inbound backlinks.

13. If no related note can be confidently identified for an UNLINKED note: record it as `UNLINKED-BLOCKED` in the artifact. Do not add speculative links.

This sweep is additive only. Do not remove or modify existing links.

## Artifact update

Append to artifact `notes`:
```text
<current_note>: backlinks normalized (outbound promoted: N, inbound added to: [list of files])
UNLINKED notes repaired: N | UNLINKED-BLOCKED: N
```

Update fields:
- `last_completed_step: 05-backlink-normalization`
- `next_step: 06-conflict-check`

## Next step

06-conflict-check
