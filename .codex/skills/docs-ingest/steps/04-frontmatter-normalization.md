---
name: docs-ingest-step-04-frontmatter-normalization
description: Normalize YAML frontmatter structure, canonical flags, metadata ordering, and required field presence for the current doctrine note.
---

# Step 04 — Frontmatter normalization

## Purpose

Ensure the current doctrine note has well-formed, machine-readable YAML frontmatter before backlink and graph operations run.

This step applies only to doctrine-class notes (`implemented`, `needs-review`).

## Scope declarations

```yaml
allowed_files:
  - queued raw note
  - destination note path
  - docs/evonotes/** existing frontmatter examples
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - frontmatter fields normalized
  - title/status/source/related metadata set
  - source provenance preserved
stop_rules:
  - required metadata cannot be inferred
  - frontmatter would contradict source note
  - destination format conflict exists
```
## Actions

1. Read the current note's existing frontmatter (if any).

2. Apply the canonical frontmatter structure. Write only what is known; do not fabricate values:

```yaml
---
lifecycle_status: <implemented | needs-review>
implementation_status: <implemented | needs-review | spec>
domain_lifecycle: <ai | connect | training | runtime | governance | core>
canonical: true
note_type: <doctrine | architecture | spec | execution | exploration | index | historical | audit>
gitnexus_verified: false
last_reviewed: <YYYY-MM-DD>
related_notes: []
---
```

3. Normalize field ordering: `lifecycle_status` first, `related_notes` last.

4. Normalize canonical flags:
   - `canonical: true` for all notes being promoted into `docs/evonotes/`.
   - `gitnexus_verified: false` unless you can confirm a prior verification run.

5. Normalize metadata values:
   - `lifecycle_status` must match the classification from step 02 (`implemented` or `needs-review`).
   - `domain_lifecycle` must match the domain determined in step 03.
   - `note_type` must be the best single-term description of the note's role.
   - `last_reviewed` must be today's date.

6. Clean the note content body:
   - Remove `(Raw Draft)` suffix from the title heading.
   - Convert HTML entities (`&gt;` → `>`, `&amp;` → `&`) if present.
   - Preserve all headings, lists, code blocks, and body content.
   - Do not add new sections or restructure the body.

7. If the note already has correctly structured frontmatter: update only the fields that are wrong or missing. Do not touch correct fields.

8. Verify required fields are present and non-empty: `lifecycle_status`, `implementation_status`, `domain_lifecycle`, `canonical`, `note_type`, `last_reviewed`, `related_notes`.

## Artifact update

Append to artifact `notes`:
```text
<current_note>: frontmatter normalized (lifecycle_status=<value>, domain_lifecycle=<value>, note_type=<value>)
```

Update fields:
- `last_completed_step: 04-frontmatter-normalization`
- `next_step: 05-backlink-normalization`

## Next step

05-backlink-normalization
