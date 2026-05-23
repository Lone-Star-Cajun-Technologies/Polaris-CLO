---
name: docs-ingest
description: Deterministic graph-integrity workflow for ingesting and normalizing notes into the EVO docs system.
---

# docs-ingest skill

Triages files in `docs/raw/`, classifies and normalizes them, enforces graph integrity, and delivers the run through a GitHub PR.

## When to use

Run this skill whenever new markdown files are added to `docs/raw/` and have not yet been processed.

## Trigger

```text
Use docs-ingest.
```

## Architecture

```text
SKILL.md        Agent entry point — reads chain.md and .taskchain_artifacts/docs-ingest/current-state.json, executes one step at a time
chain.md        Route map — step order, per-note loop, continuation rules, scope governance, doctrine anchors
.docs-ingest/
  current-run.md  Runtime state — updated after every step, survives session boundaries
  current-state.json  Machine-readable run snapshot used for fast resume
  runs/           Append-only JSONL telemetry
  summaries/      Completed human-readable run history
steps/
  01-source-intake.md           Build queue, verify visibility
  02-classify-lifecycle.md      Classify each note: audit | deprecated | duplicate | implemented | needs-review | archival | blocked
  03-placement-decision.md      Resolve destination, verify placement rules
  04-frontmatter-normalization.md  Normalize YAML structure and required fields (doctrine notes only)
  05-backlink-normalization.md  Normalize YAML/inline backlinks, orphan sweep (doctrine notes only)
  06-conflict-check.md          Detect duplicates, contradictions, migrations (doctrine notes only)
  07-write-or-move.md           Execute bounded write/move; advance queue or transition to global verification
  08-index-update.md            Global orphan, missing-index, wiki-link, and YAML backlink verification
  09-final-report.md            Summarize run, deliver PR, close artifact
```

`.docs-ingest/` is intentionally repo-root visible. `docs-ingest` operates on
repo-wide documentation state and is resumed by name from the repository root, so
the mutable run ledger stays outside `.codex/skills/docs-ingest/artifacts/`.
Do not move it without an explicit coordinated migration across every harness
and resume instruction.

## What it does

1. Builds an input queue from `docs/raw/` root.
2. Classifies each note by lifecycle: audit, deprecated, duplicate, implemented, needs-review, archival.
3. Rejects files with stale references (ENF, VOICE, MLX, Phi-4-mini, ElevenLabs) to `docs/raw/deprecated/`.
4. Routes Linear issue files to `docs/raw/audits-and-issues/`.
5. Normalizes frontmatter (YAML structure, canonical flags, metadata ordering).
6. Normalizes YAML backlinks; promotes critical inline links into machine-readable YAML.
7. Sweeps ALL existing notes in `implemented/` and `needs-review/` for missing inbound links (runs every ingest).
8. Checks for doctrine conflicts, concept duplicates, and unresolved migrations.
9. Writes or moves each note to its verified destination.
10. Warns, without blocking, when a destination or first-wave routing folder lacks a local `INSTRUCTIONS.md`.
11. Runs global graph verification: orphan detection, missing indexes, wiki-link integrity.
12. Commits, pushes, and creates or updates a draft PR.

## End state

- `docs/raw/` root contains only `README.md`.
- Every canonized note has machine-readable YAML backlinks and at least one inbound link from a non-README note.
- `.taskchain_artifacts/docs-ingest/current-state.json` reports `status: complete`.
- A real PR URL exists for any run that changed files.

## Resumability

If a run stops mid-queue, resume with:

```text
Use docs-ingest. Resume from .taskchain_artifacts/docs-ingest/current-state.json.
```

The artifact holds queue state, processed notes, and blocked items.

## Related

- Classification script: `.github/spec-kit/scripts/bash/classify-raw-docs.sh`
- Canonical template: `docs/evonotes/_templates/_TEMPLATE - Canonical Note.md`
- Evonotes README: `docs/evonotes/README.md`
- evo-run skill: `.codex/skills/evo-run/` (architectural model for this workflow)
