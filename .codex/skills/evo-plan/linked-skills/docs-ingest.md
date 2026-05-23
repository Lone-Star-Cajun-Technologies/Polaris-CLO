# docs-ingest linkage

Source: `.claude/skills/docs-ingest/SKILL.md`

---

## Allowed phases

- Pre-01 — before planning-spec-intake begins, if raw files are detected that have not been ingested

---

## Purpose

Process new files added to `docs/raw/` before evo-plan reads them. Ensures raw files are correctly classified, archived, deprecated, or promoted to canonical notes before doctrine traversal begins.

---

## Allowed scope

- Ingest new files detected in `docs/raw/` that are not yet classified
- Run the backlink sweep for unlinked notes in `implemented/` and `needs-review/`

---

## Forbidden scope

- Do not invoke during or after Phase 03 — doctrine traversal must use already-ingested notes
- Do not manually promote raw files into `docs/evonotes/` — the ingest skill handles classification
- Do not invoke if no new unclassified raw files are present

---

## Invocation note

Check for unclassified files in `docs/raw/` before starting Phase 01. If new files are present, invoke docs-ingest before proceeding. Do not begin planning-spec-intake until ingestion is complete.
