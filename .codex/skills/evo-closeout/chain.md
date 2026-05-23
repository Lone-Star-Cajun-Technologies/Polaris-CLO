---
name: evo-closeout-chain
description: Route map for evo-closeout — step order, promotion rules, GitNexus requirement, artifact update requirements, and execution reporting.
---

# evo-closeout chain

## Step traversal order

```text
01-fetch-and-orient
02-locate-planning-specs
03-read-linked-prs
04-gitnexus-graph-check
05-compare-planned-vs-implemented
06-closeout-decision           ← emits one of four outcomes; no file movement yet
07-closeout-action             ← terminal step; branches on decision from 06
```

## Closeout decision routing (step 06 → step 07)

| Decision | Condition | Step 07 action |
|---|---|---|
| `closeout_passed` | All checks pass | Promote spec to implemented |
| `closeout_blocked` | One or more checks fail | Produce blocker report; no file movement |
| `closeout_partial` | Partial criteria met; user explicitly requests promotion | Promote with gaps documented |
| `needs_human_decision` | Ambiguous findings requiring human judgment | Hold and report; no file movement |

## Stop conditions

**Step 06:**
Emit the closeout decision before taking any file action. Do not proceed to step 07 until the decision is explicitly stated.

**Any step:**
Stop if:
- No planning spec is found and the user has not provided a path — ask before proceeding.
- GitNexus index is stale and cannot be refreshed — mark as `closeout_blocked` or `closeout_partial`.
- Canonical doctrine conflict discovered that cannot be resolved without user input.
- Parent is not Done or Cancelled — report open state and ask the user whether to proceed.

## Promotion rules (non-negotiable)

Planning specs must NOT be moved to implemented unless ALL of the following are true:

- The parent issue set is complete (Done or Cancelled with resolution).
- Implementation matches the planning spec scope and acceptance criteria.
- GitNexus confirms relevant code paths were touched.
- Test or manual validation evidence is documented.
- No blocking doctrine conflict remains open.
- No required acceptance criterion from the original scope is still unmet.

Partial completion does not qualify for promotion unless the user explicitly requests it and acknowledges the remaining gaps.

## GitNexus requirement

GitNexus must be queried in every closeout run.

If implementation touched relevant code paths and GitNexus has not been re-indexed since those commits:
- Mark closeout as `closeout_blocked` or `closeout_partial`.
- Include a stale-index warning in the report.
- Run `npx gitnexus analyze` and re-check before unblocking.

## Artifact Authority

`.taskchain_artifacts/evo-closeout/current-state.json` is the sole authoritative live state surface for evo-closeout. Agents resume from this snapshot — not from `current-run.md` (deprecated) or by replaying telemetry.

`run-report.md` (`.taskchain_artifacts/evo-closeout/run-report.md`) is a generated closeout artifact written once at run completion or handoff. It is never updated per-step.

`current-run.md` is deprecated. Existing files are retained as historical records only. Do not create or update `current-run.md` in new runs.

## Run ID Format

Format: `evo-closeout-<slug>-<date>-<sequence>` (e.g., `evo-closeout-caveman-enforcement-2026-05-22-001`).
Tracker IDs must NOT appear in the slug.

## Artifact update requirement

After every completed step, update `.taskchain_artifacts/evo-closeout/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.taskchain_artifacts/evo-closeout/current-state.json` updated successfully.

If the artifact update fails, stop and report the failure.

## Machine Snapshot

The machine snapshot is the authoritative live state for evo-closeout.

- **Path**: `.taskchain_artifacts/evo-closeout/current-state.json`
- **Schema reference**: `.evo/run-state/current-state-schema.md`
- **Update requirement**: update after every completed step
- **Purpose**: enables fast agent resume without replaying markdown history or JSONL

## Telemetry

Telemetry is append-only operational history for audit, replay, and debugging.

- **Path pattern**: `.taskchain_artifacts/evo-closeout/runs/[run-id].jsonl`
- **Event catalog reference**: `.evo/run-state/event-catalog.md`
- **Append-only rule**: never delete or modify existing lines — only append new events
- **Purpose**: records what actually happened during a run; not used as the primary resume source
- **Legacy telemetry**: pre-migration files in `.codex/skills/evo-closeout/artifacts/runs/` are historical records
- **Telemetry compliance**: new events must conform to `.evo/run-state/event-catalog.md` — no other field names are valid
- **Required fields**: `event`, `run_id`, `timestamp`, `step_id` (all events)
- **Deprecated field**: `ts` — do not use in new runs; pre-governance alias for `timestamp`
- **Non-conforming fields**: `event_type` and `summary` are not catalog fields; do not emit them in new runs

## Validation Summarization

Validation output written to `.taskchain_artifacts/evo-closeout/current-state.json` must be a concise summary — never raw command output or full diff excerpts.

- **Permitted**: pass/fail status per criterion; one-line evidence reference; count of checks; first failing check only
- **Prohibited**: raw stdout/stderr; full git diffs; verbose test output; per-file lint listings
- **Maximum**: 5–10 lines total per validation check recorded in the artifact

This rule applies to all steps that record pass/fail verdicts or implementation evidence.

## Execution reporting

## Linked-Skill Invocation Boundaries

| Skill | Allowed steps | Condition | Descriptor |
|---|---|---|---|
| caveman | session start | mandatory (lite mode) | linked-skills/caveman.md |
| gitnexus | 04 | mandatory every closeout run | linked-skills/gitnexus.md |

Invoke caveman-lite at session start. It governs all user-facing responses for the duration of the run.

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <files promoted / moved / frontmatter updated> or none
Validated: <checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full regardless of caveman mode:
- Promoted spec frontmatter content
- Blocker reports and partial promotion gap lists
- Doctrine conflict findings
- Closeout-blocked and integrity-blocked explanations
- Final report (step 07)

## Token discipline

- Query GitNexus for specific symbols and flows — do not dump the full index.
- Read only files referenced in PRs, commits, or child issue scopes.
- Do not summarize the entire codebase.
- Do not perform broad repo search unless a specific gap cannot be located by targeted inspection.
- Prefer narrow, evidence-based inspection over exhaustive coverage.
