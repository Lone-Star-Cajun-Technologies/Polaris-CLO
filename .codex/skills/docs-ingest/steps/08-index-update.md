---
name: docs-ingest-step-08-index-update
description: Run global graph verification — orphan detection, missing index detection, wiki-link integrity, and backlink resolution — after all notes have been processed.
---

# Step 08 — Index update

## Purpose

Verify the graph is structurally sound after all notes in this run have been processed. This step runs once per ingest run, not per note.

## Scope declarations

```yaml
allowed_files:
  - new or updated canonical note
  - docs/evonotes/**/README.md
  - docs/evonotes/**/*MOC*.md
  - docs/evonotes/**/*.md listed in related_notes
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - indexes and backlinks updated
  - referenced related notes exist
  - changed docs list recorded
stop_rules:
  - index target cannot be identified
  - index update conflicts with do-not-update instruction
  - newly canonized note has broken outbound links (INTEGRITY-BLOCKED)
```
## Actions

### 1 — Orphan detection

Find notes in `docs/evonotes/` that exist on disk but are NOT referenced in their folder's `README.md`:

```bash
find docs/evonotes -type d -print0 | while IFS= read -r -d '' dir; do
  readme="$dir/README.md"
  [ -f "$readme" ] || continue
  for f in "$dir"/*.md; do
    [ -f "$f" ] || continue
    base="$(basename "$f" .md)"
    [[ "$base" == "README" ]] && continue
    [[ "$base" == _* ]] && continue
    escaped_base="$(printf '%s' "$base" | sed 's/[][(){}.,^$*+?|\\/]/\\&/g')"
    if ! grep -qE "\[\[${escaped_base}(\]\]|[|#])" "$readme"; then
      echo "ORPHAN: $f"
    fi
  done
done
```

Record all orphans in the artifact. Do not automatically add them to READMEs — report only.

### 2 — Missing index detection

Report any directory under `docs/evonotes/` that has more than 3 `.md` files but no `README.md`:

```bash
find docs/evonotes -type d -print0 | while IFS= read -r -d '' dir; do
  count=$(find "$dir" -maxdepth 1 -name "*.md" -print0 | tr -cd '\0' | wc -c)
  [ "$count" -gt 3 ] || continue
  [ -f "$dir/README.md" ] && continue
  echo "MISSING INDEX: $dir ($count files)"
done
```

### 3 — Wiki-link integrity

For each note canonized in this ingest run: extract all `[[wiki-link]]` references and verify the target basename exists somewhere under `docs/evonotes/`:

```bash
# Run for each newly canonized file
grep -o '\[\[[^]]*\]\]' "<CANONIZED_FILE>" | sed 's/\[\[//;s/\]\]//' | while IFS= read -r link; do
  target=$(echo "$link" | cut -d'|' -f1 | cut -d'#' -f1)
  found=$(find docs/evonotes -name "${target}.md" 2>/dev/null | head -1)
  [ -z "$found" ] && echo "BROKEN LINK: [[$link]] in <CANONIZED_FILE>"
done
```

Report broken links. Do not auto-fix — report only.

### 4 — YAML backlink resolution

For each note canonized in this run, verify that every basename listed in `related_notes` YAML actually exists under `docs/evonotes/`:

```bash
# Extract related_notes values and check existence
awk '/^related_notes:/{in_block=1; next} in_block && /^[^[:space:]-]/{in_block=0} in_block{print}' "<CANONIZED_FILE>" | grep -oP '(?<=\[\[)[^\]]+(?=\]\])' | while IFS= read -r ref; do
  target=$(echo "$ref" | cut -d'|' -f1 | cut -d'#' -f1)
  found=$(find docs/evonotes -name "${target}.md" 2>/dev/null | head -1)
  [ -z "$found" ] && echo "BROKEN YAML BACKLINK: [[${ref}]] in <CANONIZED_FILE>"
done
```

### 5 — Traversal root update

If this ingest run created a new subdomain folder (e.g. `spec/infrastructure/`): update `docs/evonotes/00-index/README.md` to include the new folder in the Root Traversal Map table. This applies only to new top-level domain or lifecycle directories, not individual note placements.

### 6 — First-wave `INSTRUCTIONS.md` coverage check

Report, but do not block on, missing `INSTRUCTIONS.md` files for the first-wave routing folders:

```bash
for dir in \
  flutter_app \
  flutter_app/ios \
  flutter_app/android \
  flutter_app/macos \
  flutter_app/windows \
  apps \
  apps/evo_connect \
  app \
  packages \
  supabase \
  docs \
  .github \
  .codex \
  .claude
do
  [ -f "$dir/INSTRUCTIONS.md" ] || echo "MISSING INSTRUCTIONS: $dir/INSTRUCTIONS.md"
done
```

Record any missing entries as warnings in the artifact. These warnings are routing visibility findings, not ingest integrity blockers.

## Evaluation

If graph verification passes cleanly: proceed to step 09.

If orphans, missing indexes, broken links, or broken YAML backlinks are found: record them all in the artifact. Proceed to step 09 anyway — these findings become items in the final report, not blockers (unless a newly canonized note has broken links, which is a blocker).

A newly canonized note with broken outbound wiki-links or broken YAML backlink references is a `INTEGRITY-BLOCKED` condition. Record it, do not finalize the note as delivered, and include the specific broken links in the report.

## Artifact update

```yaml
last_completed_step: 08-index-update
next_step: 09-final-report
notes: |
  Graph verification:
  - Orphans: N (list)
  - Missing indexes: N (list)
  - Broken wiki-links: N (list)
  - Broken YAML backlinks: N (list)
  - Traversal root updated: yes/no
  - INSTRUCTIONS.md warnings: N (list)
```

## Next step

09-final-report
