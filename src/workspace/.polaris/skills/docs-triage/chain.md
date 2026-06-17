---
name: docs-triage-chain
description: Route map for docs-triage — step order, stop conditions, output contract, and CLI reference.
---

# docs-triage chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer triage scope or prior progress from conversation context.

## CLI

Always use the repo-local Polaris CLI:

```
polaris docs triage [--dry-run] [--batch-size <n>] [--resume] [--repo-root <path>]
```

- `--dry-run`: prints cluster count, estimated batches, estimated tokens, and model — no LLM calls
- `--batch-size <n>`: docs per LLM call (default: 10)
- `--resume`: resume from last checkpoint (auto-detected if checkpoint exists)

Never assume a globally linked `polaris` command exists.

## Output contract

All outputs written to `smartdocs/raw/`:

| File | Purpose |
|------|---------|
| `_triage-queue.json` | Machine-readable flag list — fed directly into `polaris docs review` |
| `_triage-report.md` | Human-readable summary — display only, never parsed |
| `_triage-checkpoint.json` | Resume state — deleted automatically on completion |

## Step traversal order

```text
01-orient-triage     ← dry-run first to confirm cluster count and cost estimate; emit telemetry
02-run-triage        ← polaris docs triage (with --resume if checkpoint exists)
03-verify-outputs    ← confirm _triage-queue.json and _triage-report.md written; read summary
04-hand-off          ← report flag counts by type; instruct user to run polaris docs review
```

## Stop conditions

**Any step:**
- `ANTHROPIC_API_KEY` not available → halt, report: "Set ANTHROPIC_API_KEY and re-run"
- `smartdocs/doctrine/active/` or `smartdocs/doctrine/candidate/` not found → halt, report
- `_triage-queue.json` not written after pipeline completes → halt, report

**Step 01 (dry-run):**
- Estimated batches > 500 → pause and surface cost estimate to user before proceeding

**Step 02 (run-triage):**
- Checkpoint detected → pass `--resume` automatically
- Graph symbol count < 1000 → Phase 2 skipped (this is expected — log and continue)

## Run ID format

Format: `docs-triage-<date>-<seq>`
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `docs-triage-2026-06-14-001`

## Telemetry

Telemetry file: `.taskchain_artifacts/docs-triage/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Trigger |
|-------|---------|
| `run-start` | Begin step 01 |
| `step-complete` | End of every step |
| `triage-dry-run-complete` | Dry-run summary printed |
| `triage-complete` | Pipeline finished, outputs written |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Execution reporting

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <outputs written> or none
Validated: <checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full:
- Flag count summary (contradictions / duplicates / stale-references)
- Any batches skipped due to API errors
- Phase 2 skip warning if graph coverage is low
- Hand-off instructions for `polaris docs review`
