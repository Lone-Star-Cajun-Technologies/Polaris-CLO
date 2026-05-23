---
name: evo-analyze-chain
description: Route map for evo-analyze — step order, stop conditions, artifact update requirements, and execution reporting.
---

# evo-analyze chain

## Step traversal order

```text
01-fetch-and-orient      ← parallel: Linear fetch + GitNexus freshness
02-map-affected-code     ← targeted GitNexus inspection
03-assess-issue          ← outcome classification
04-blocker-check         ← STOP if blocked
05-create-child-issues   ← create / update ordered child issues
06-final-report          ← terminal step
```

## Stop conditions

**Step 04 (blocker check):**
Stop immediately if the issue is blocked. Add comment and label, then halt. Do not advance to step 05.

**Any step:**
Stop if:
- Canonical doctrine conflict cannot be resolved without user input.
- HIGH or CRITICAL risk symbol identified by GitNexus without a clear resolution path.
- Parent issue is already Done or Cancelled.

## Artifact Authority

`.taskchain_artifacts/evo-analyze/current-state.json` is the sole authoritative live state surface for evo-analyze. Agents resume from this snapshot — not from `current-run.md` (deprecated) or by replaying telemetry.

`run-report.md` (`.taskchain_artifacts/evo-analyze/run-report.md`) is a generated closeout artifact written once at run completion or handoff. It is never updated per-step.

`current-run.md` is deprecated. Existing files are retained as historical records only. Do not create or update `current-run.md` in new runs.

## Artifact update requirement

After every completed step, update `.taskchain_artifacts/evo-analyze/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.taskchain_artifacts/evo-analyze/current-state.json` updated successfully.

If the artifact update fails, stop and report the failure.

## Machine Snapshot

The machine snapshot is the authoritative live state for evo-analyze.

- **Path**: `.taskchain_artifacts/evo-analyze/current-state.json`
- **Schema reference**: `.evo/run-state/current-state-schema.md`
- **Update requirement**: update after every completed step
- **Purpose**: enables fast agent resume without replaying markdown history or JSONL

## Run ID Format

Format: `evo-analyze-<slug>-<date>-<sequence>` (e.g., `evo-analyze-calendar-mobile-2026-05-22-001`).
Tracker IDs must NOT appear in the slug.

## Telemetry

Telemetry is append-only operational history for audit, replay, and debugging.

- **Path pattern**: `.taskchain_artifacts/evo-analyze/runs/[run-id].jsonl`
- **Event catalog reference**: `.evo/run-state/event-catalog.md`
- **Append-only rule**: never delete or modify existing lines — only append new events
- **Purpose**: records what actually happened during a run; not used as the primary resume source
- **Legacy telemetry**: pre-migration files in `.codex/skills/evo-analyze/artifacts/runs/` are historical records
- **Telemetry compliance**: new events must conform to `.evo/run-state/event-catalog.md` — no other field names are valid
- **Required fields**: `event`, `run_id`, `timestamp`, `step_id` (all events)
- **Deprecated field**: `ts` — do not use in new runs; pre-governance alias for `timestamp`
- **Non-conforming fields**: `event_type` and `summary` are not catalog fields; do not emit them in new runs

## Validation Summarization

Analysis and assessment output written to `.taskchain_artifacts/evo-analyze/current-state.json` must be concise summaries — never raw tool output or full file listings.

- **Permitted**: pass/fail status; finding summaries; one-line-per-item findings; first error or first failing check only
- **Prohibited**: raw stdout/stderr; full file contents; verbose GitNexus dumps; per-file lint or test listings
- **Maximum**: 5–10 lines per finding or check recorded in the artifact

This rule applies to all steps that record findings, assessments, or analysis results.

## Execution reporting

## Linked-Skill Invocation Boundaries

| Skill | Allowed steps | Condition | Descriptor |
|---|---|---|---|
| caveman | session start | mandatory (lite mode) | linked-skills/caveman.md |
| gitnexus | 01, 02 | targeted lookup only | linked-skills/gitnexus.md |

Invoke caveman-lite at session start. It governs all user-facing responses for the duration of the run.

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <Linear issues created / updated> or none
Validated: <checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full regardless of caveman mode:
- Child issue bodies (generated planning artifacts)
- Blocker reports and unblock conditions
- Doctrine conflict findings
- HIGH or CRITICAL risk findings from GitNexus
- Final report (step 06)

## Token discipline

- Query GitNexus for the concept — do not dump the full index.
- Read only files relevant to the issue scope.
- Do not carry broad context between steps.
- Prefer narrow, targeted inspection over exhaustive search.
