---
name: docs-ingest-step-06-conflict-check
description: Detect duplicate concepts, doctrine contradictions, overlapping notes, and unresolved migrations before writing.
---

# Step 06 — Conflict check

## Purpose

Catch integrity-breaking conflicts before the note is written or moved. A conflict that is written becomes debt that compounds.

## Scope declarations

```yaml
allowed_files:
  - destination note draft
  - docs/evonotes/**/*.md selected by key concepts
  - stale-reference doctrine listed in AGENTS.md
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/docs-ingest/chain.md
  - docs/raw/README.md
  - docs/evonotes/**/INSTRUCTIONS.md
allowed_skills:
  - none
expected_evidence:
  - conflicting doctrine checked
  - stale references resolved or blocked
  - promotion decision recorded
stop_rules:
  - conflict with current doctrine exists
  - stale reference cannot be resolved
  - note contradicts active implementation without follow-up
```
## Actions

1. **Duplicate concept check**: search `docs/evonotes/` for notes covering the same concept as the current note (even under a different filename):

```bash
# Extract key concept terms from the note title and headings
# Search for any notes that define or extensively describe those terms
rg -l "CONCEPT_TERM" docs/evonotes --glob '*.md' | grep -v '/README\.md$'
```

If a semantically duplicate note is found at a different path: record the conflict. Do not proceed with a write that would create a duplicate doctrine definition. Escalate as `CONFLICT-BLOCKED`.

2. **Doctrine contradiction check**: verify the current note does not contradict active doctrine in `docs/evonotes/implemented/`:
   - Compare claims about `LoRAKind`, safety architecture, inference runtime, model names, TTS stack against doctrine anchors in chain.md.
   - If a contradiction is found: classify this note as `deprecated` or `blocked`, depending on severity. Record the contradiction.

3. **Overlapping scope check**: if multiple notes in the queue define or modify the same concept, record the overlap. Process the most authoritative (most recent, most complete) note first, and flag the others for human review.

4. **Unresolved migration check**: verify the current note does not reference a path, concept, or system that was migrated away from without a documented replacement:
   - Common examples: Convex → Supabase, ElevenLabs → Supertonic, MLX → GGUF.
   - If the note assumes a migrated-away system still exists: classify `deprecated`.

5. **Placement collision re-check**: if step 03 recorded a destination collision (a file with the same basename already exists at destination), resolve it now:
   - If the existing file is identical or superseded: route current note to `docs/raw/archived/` instead.
   - If the existing file is outdated: record which file should be updated and whether this run should do it (stay in scope).
   - If resolution is ambiguous: record as `CONFLICT-BLOCKED`.

## Escalation

If `CONFLICT-BLOCKED`:
- Record the conflict in the artifact with the conflicting file path and nature of the conflict (maximum 3 lines: path, nature, resolution status — no raw file content).
- Set `next_step: halted` for this note.
- Do not write or move the note.
- Report the conflict at the end of the run in the final report (step 09).

Non-blocking conflicts (mild overlap, minor inconsistency) are recorded as warnings and do not halt execution.

## Artifact update

Append to artifact `notes`:
```text
<current_note>: conflict check — <clean | N conflicts found: list>
```

Update fields:
- `last_completed_step: 06-conflict-check`
- `next_step: 07-write-or-move` (or `halted` if CONFLICT-BLOCKED)

## Next step

07-write-or-move (or halted if CONFLICT-BLOCKED)
