---
name: docs-ingest-step-02-classify-lifecycle
description: Determine lifecycle classification for the current note and detect lifecycle conflicts.
---

# Step 02 — Classify lifecycle

## Purpose

Assign a definitive lifecycle classification to the current note. Classification governs all subsequent placement and normalization decisions.

## Scope declarations

```yaml
allowed_files:
  - queued raw note
  - docs/raw/deprecated/**
  - docs/raw/audits-and-issues/**
  - docs/evonotes/**/* matching queued content
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - lifecycle classification assigned
  - stale-reference scan completed
  - existing canonical counterpart checked
stop_rules:
  - deprecated reference requires resolution
  - classification is ambiguous
  - raw note already has canonical counterpart
```
## Actions

1. Read `current_note` path from the artifact.
2. Read the file content.
3. Apply this classification priority order (first match wins):

| Priority | Signal | Classification | Next destination |
|----------|--------|---------------|-----------------|
| 1 | Filename matches Linear issue prefix | `audit` | `docs/raw/audits-and-issues/` |
| 2 | Content references ENF, VOICE adapter, MLX, Phi-4-mini, or ElevenLabs | `deprecated` | `docs/raw/deprecated/` |
| 3 | Basename exists anywhere under `docs/evonotes/` | `duplicate-archive` | `docs/raw/archived/` |
| 4 | Describes active, specification-complete doctrine | `implemented` | `docs/evonotes/implemented/<domain>/` |
| 5 | Describes drafted or candidate doctrine | `needs-review` | `docs/evonotes/needs-review/<domain>/` |
| 6 | Older spec, operational guide, or context note | `archival` | `docs/raw/archived/` |
| 7 | Cannot be confidently classified | `blocked` | — |

4. Detect lifecycle conflicts:
   - If existing `lifecycle_status` frontmatter contradicts the inferred classification, record the conflict in the artifact notes.
   - If the file mixes deprecated and current component references, record the partial staleness.

5. If classification is `blocked`: record reason in artifact, set `next_step: halted`, and stop processing this note.

## Stale reference detection

Check file content (case-insensitive) for:

```bash
# Run from repo root; replace FILEPATH with actual path
grep -iE "(ENF adapter|ENF LoRA|VOICE adapter|VOICE LoRA|\bMLX\b|Phi-4-mini|ElevenLabs)" "<FILEPATH>"
```

Presence of any match → classify `deprecated`.

Note: match `ENF` only when it appears as an adapter or LoRA variant name, not as an unrelated acronym.

## Linear issue prefix patterns

```bash
# Check if filename matches Linear issue pattern
basename "<FILEPATH>" | grep -E '^(EVOS1|EVOC|EVOTRA|EVOMIND|EVOFL)-[0-9]+'
# Or any [UPPER]-[NUMBER] pattern:
basename "<FILEPATH>" | grep -E '^[A-Z]+-[0-9]+'
```

## Artifact update

Append to artifact `notes`:
```text
<current_note>: classified as <classification>
```

Update fields:
- `last_completed_step: 02-classify-lifecycle`
- `next_step: 03-placement-decision` (or `halted` if blocked)

## Next step

03-placement-decision (or halted if blocked)
