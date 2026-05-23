---
name: docs-ingest-chain
description: Route map — step order, continuation rules, artifact requirements, and scope governance for docs-ingest.
---

# docs-ingest chain

## Step traversal order

```text
01-source-intake           ← identify queue, set run context; executes once per run
  ↓
02-classify-lifecycle      ┐
03-placement-decision      │  per-note loop: repeats for each note in queue
04-frontmatter-normalization  │  doctrine notes only (implemented, needs-review)
05-backlink-normalization  │  doctrine notes only
06-conflict-check          │  doctrine notes only
07-write-or-move           ┘  ← executes bounded write/move; evaluates queue state
  ↓ (ALL_NOTES_DONE)
08-index-update            ← global graph verification; runs once after all notes processed
  ↓
09-final-report            ← summarize and deliver PR; terminal step
```

### Per-note routing

Steps 04, 05, and 06 apply only to doctrine candidates (`implemented` or `needs-review`).

Raw-routed notes (`audit`, `deprecated`, `duplicate-archive`, `archival`) skip from step 03 directly to step 07.

## Continuation rules

After step 07 completes for one note:

- **NEXT_NOTE**: queue has remaining unprocessed notes → return to step 02 with the next note as `current_note`.
- **ALL_NOTES_DONE**: queue is empty → advance to step 08.
- **STOP (token/context risk)**: halt cleanly. Persist queue remainder and current_note in artifact. Provide resume command.
- **BLOCKED**: halt immediately. Record blocking reason in artifact. Report and stop.

After step 08:

- **COMPLETE**: proceed to step 09.
- **STOP (integrity failures)**: halt and report all integrity failures before producing the final report.

## Session boundary rule

- One ingest queue per session.
- Resumability comes from `.taskchain_artifacts/docs-ingest/current-state.json`, not session memory.
- A resumed session reads the snapshot, restores `queue` and `current_note`, and re-enters at `current_step_id`.

## Artifact Authority

`.taskchain_artifacts/docs-ingest/current-state.json` is the sole authoritative live state surface for docs-ingest. Agents resume from this snapshot — not from `current-run.md` (deprecated) or by replaying telemetry.

`run-report.md` (`.taskchain_artifacts/docs-ingest/run-report.md`) is a generated closeout artifact written once at run completion or handoff. It is never updated per-step.

`current-run.md` is deprecated. Existing files are retained as historical records only. Do not create or update `current-run.md` in new runs.

## Run ID Format

Format: `docs-ingest-<slug>-<date>-<sequence>` (e.g., `docs-ingest-ai-routing-docs-2026-05-22-001`).
Tracker IDs must NOT appear in the slug.

## Artifact update requirement

After every completed step, update `.taskchain_artifacts/docs-ingest/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.taskchain_artifacts/docs-ingest/current-state.json` updated successfully.

If the artifact update fails, stop immediately and report the failure.

## Machine Snapshot

The machine snapshot is the authoritative live state for docs-ingest.

- **Path**: `.taskchain_artifacts/docs-ingest/current-state.json`
- **Schema reference**: `.evo/run-state/current-state-schema.md`
- **Update requirement**: update after every completed step
- **Purpose**: enables fast agent resume without replaying markdown history or JSONL

## Telemetry

Telemetry is append-only operational history for audit, replay, and debugging.

- **Path pattern**: `.taskchain_artifacts/docs-ingest/runs/[run-id].jsonl`
- **Event catalog reference**: `.evo/run-state/event-catalog.md`
- **Append-only rule**: never delete or modify existing lines — only append new events
- **Purpose**: records what actually happened during a run; not used as the primary resume source
- **Legacy telemetry**: pre-migration files in `.docs-ingest/runs/` are historical records; do not move or delete them
- **Telemetry compliance**: new events must conform to `.evo/run-state/event-catalog.md` — no other field names are valid
- **Required fields**: `event`, `run_id`, `timestamp`, `step_id` (all events)
- **Deprecated field**: `ts` — do not use in new runs; pre-governance alias for `timestamp`
- **Non-conforming fields**: `event_type` and `summary` are not catalog fields; do not emit them in new runs

## Validation Summarization

Conflict check and assessment output written to `.taskchain_artifacts/docs-ingest/current-state.json` must be concise — never raw file content or full doctrine excerpts.

- **Permitted**: conflict status (clean/blocked); conflicting file path and nature of conflict; one-line resolution status
- **Prohibited**: raw file content; full doctrine excerpts; verbose tool output
- **Maximum**: 3–5 lines per conflict or check recorded in the artifact

This rule applies to all steps that record conflict checks, placement decisions, or validation results.

## Completion rule

Do not report workflow completion until `.taskchain_artifacts/docs-ingest/current-state.json` has `status: complete`.

## Scope governance

- Process only files in `docs/raw/` root (or the explicit file provided at invocation).
- Do not redesign EVOnotes architecture or invent new lifecycle categories.
- Do not rewrite existing canonized notes beyond frontmatter normalization and backlink repair.
- Do not run mass migrations or flatten the repository.
- Out-of-scope discoveries become follow-up items in the report, not immediate actions.

## Doctrine anchors (stale reference detection)

Files recommending deprecated components must be classified `deprecated`, not promoted:

| Deprecated | Replacement |
|------------|-------------|
| ENF adapter | GatingEngine + AnswerRepair (two-layer) |
| VOICE adapter | Removed; no replacement |
| MLX inference | GGUF + llama.cpp |
| Phi-4-mini | Qwen2.5-1.5B Q4_K_M |
| ElevenLabs TTS | Supertonic 2 on-device ONNX |

## Execution reporting

Invoke caveman-lite at session start. It governs all user-facing responses for the duration of the run.

After each completed step and after each note in the per-note loop, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <files / artifacts / branches / issues> or none
Validated: <commands / checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full regardless of caveman mode:
- Canonized note content (frontmatter, body, backlinks)
- Safety warnings
- Conflict escalation
- Irreversible-action confirmations (overwrites, deletions)
- Blocker descriptions (must be fully explicit)
- INTEGRITY-BLOCKED and CONFLICT-BLOCKED explanations
- Final report (step 09) run summary
