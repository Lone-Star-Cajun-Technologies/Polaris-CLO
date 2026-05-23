---
name: evo-run-chain
description: Route map for evo-run — defines step order, continuation rules, and artifact update requirements.
---

# evo-run chain

## Step traversal order

```text
01-orient-cluster
02-prepare-branch
03-select-child          ← loops back here after 07 decides to continue
04-execute-child
05-validate-child
06-commit-and-update-linear
07-decide-continuation   → CONTINUE: go to 03 | STOP: report and halt | DELIVER: go to 08
08-final-delivery        ← only reached when all children are Done and user requests delivery
```

## Continuation rules

After step 07 evaluates the session:

- **CONTINUE**: return to step 03 within the same parent cluster session. Re-fetch the child list. Select the next lowest-numbered open child.
- **STOP (token/context risk)**: halt execution cleanly when any measurable stop threshold is met (see step 07). Report completed child, commit hash, next open child ID, and the command to resume in a fresh session. Do not push. Do not create a PR.
- **STOP (blocked)**: follow the blocker protocol in step 06. Halt immediately. Do not advance to later children.
- **DELIVER**: proceed to step 08 only when all children are Done and the user explicitly requests final delivery.

## Context budget

Track these counters in `current-state.json` under `context_budget` and update after each child completes:

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 4 → STOP |
| `files_touched_total` | Total files changed across all children this session | > 50 → STOP |
| `last_child_files_touched` | Files changed by the most recently completed child | > 20 → STOP |
| `last_validation_lines` | Largest validation output line count this session | > 20 → note; adjust scope |

Update `context_budget` after step 06 completes for each child.

## Session boundary rule

- One parent cluster per session. Never run two parent clusters in one session.
- A fresh session per child is optional, not the default. Use it only when any context budget threshold is reached, or when validation breadth, log noise, repo dirtiness, or scope growth makes continuation unsafe.
- Continuity between sessions comes from Linear state, git commits, branch state, PR state, and `.taskchain_artifacts/evo-run/current-state.json` — not from session memory.

## Run Identity

Every invocation of evo-run generates a unique `run_id` at the start of step 01, before any operational work begins.

- Format: `evo-run-<slug>-<date>-<sequence>` (e.g., `evo-run-artifact-refactor-2026-05-22-001`)
- `<slug>`: 2–4 lowercase hyphenated words from the work title. **Tracker IDs must NOT appear in the slug.**
- `run_id` persists for the entire lifecycle of this execution session
- Resumed sessions generate a new `run_id` and record the prior one in `related_run_id`
- `run_id` must appear in: `.taskchain_artifacts/evo-run/current-state.json`, JSONL telemetry, Linear evidence comments, and PR body footer

See `.evo/run-state/lineage-governance.md` for complete lineage rules.

## Run Lifecycle

| State | Trigger |
|-------|---------|
| `orienting` | Step 01 begins |
| `ready` | Step 02 completes — branch prepared |
| `executing` | Step 04 begins |
| `validating` | Step 05 begins |
| `continuing` | Step 07 decides CONTINUE |
| `blocked` | Blocker found at any step |
| `all-children-complete` | Step 07 decides DELIVER |
| `delivering` | Step 08 begins |
| `complete` | Step 08 completes — PR delivered |
| `stopped` | Step 07 decides STOP (token/context risk) |

A run that terminates in `stopped` state is resumable via a new session. Emit `run-stopped` telemetry before halting.

## Telemetry Enforcement

Telemetry events must be emitted at these specific moments (not optional):

| Event | Step |
|-------|------|
| `run-start` | Step 01 — immediately after `run_id` is generated; first event in JSONL |
| `compression-mode-started` | Step 01 — immediately after `run-start`; caveman invocation begins |
| `compression-mode-validated` | Step 01 — after caveman confirmed active |
| `compression-mode-failed` | Step 01 — when activation fails; execution halts |
| `step-start` | Beginning of every step |
| `step-complete` | End of every step |
| `branch-created` | Step 02 |
| `blocker-found` | Any step when a blocker halts execution |
| `commit-created` | Step 06 |
| `tracker-updated` | Step 06 — child marked Done |
| `linear-linked` | Step 06 — run_id written to Linear comment |
| `pr-opened` | Step 08 |
| `pr-metadata` | Step 08 — run_id footer written to PR |
| `run-complete` | Step 08 — terminal |
| `run-stopped` | Step 07 when STOP decision is emitted |

Telemetry path: `.taskchain_artifacts/evo-run/runs/[run-id].jsonl` (append-only).
Event catalog reference: `.evo/run-state/event-catalog.md`.

## Artifact update requirement

After every completed step, update `.taskchain_artifacts/evo-run/current-state.json` before advancing.

A step is NOT complete until:
1. operational action completed
2. validation completed (if applicable)
3. `.taskchain_artifacts/evo-run/current-state.json` updated successfully

If the artifact update fails, stop immediately and report the artifact persistence failure.

## Artifact Authority

`.taskchain_artifacts/evo-run/current-state.json` is the sole authoritative live state surface for evo-run. Agents resume from this snapshot — not from `current-run.md` (deprecated) or by replaying telemetry.

`run-report.md` (`.taskchain_artifacts/evo-run/run-report.md`) is a generated closeout artifact written once at run completion or handoff. It is never updated per-step.

`current-run.md` is deprecated. Existing files are retained as historical records only. Do not create or update `current-run.md` in new runs.

## Machine Snapshot

The machine snapshot is the authoritative live state for evo-run.

- **Path**: `.taskchain_artifacts/evo-run/current-state.json`
- **Schema reference**: `.evo/run-state/current-state-schema.md`
- **Update requirement**: update after every completed step
- **Purpose**: enables fast agent resume without replaying markdown history or JSONL

## Telemetry

Telemetry is append-only operational history for audit, replay, and debugging.

- **Path pattern**: `.taskchain_artifacts/evo-run/runs/[run-id].jsonl`
- **Event catalog reference**: `.evo/run-state/event-catalog.md`
- **Append-only rule**: never delete or modify existing lines — only append new events
- **Purpose**: records what actually happened during a run; not used as the primary resume source
- **Legacy telemetry**: pre-migration files in `.evo-run/runs/` are historical records; do not move or delete them
- **Telemetry compliance**: new events must conform to `.evo/run-state/event-catalog.md` — no other field names are valid
- **Required fields**: `event`, `run_id`, `timestamp`, `step_id` (all events)
- **Deprecated field**: `ts` — do not use in new runs; pre-governance alias for `timestamp`
- **Non-conforming fields**: `event_type` and `summary` are not catalog fields; do not emit them in new runs

## Validation Summarization

Validation output written to `.taskchain_artifacts/evo-run/current-state.json` must be a concise summary — never raw command output.

- **Permitted**: pass/fail status; command names only; count of checks passed/failed/skipped; first error line only (if failed)
- **Prohibited**: raw stdout/stderr; per-file lint listings; full test output; verbose build logs
- **Maximum**: 5–10 lines total per validation check recorded in the artifact

This rule applies to all steps that record validation results.

## Completion rule

Do not report workflow completion until `.taskchain_artifacts/evo-run/current-state.json` has `status: complete`.

## Linked-Skill Invocation Boundaries

| Skill | Allowed steps | Condition | Descriptor |
|---|---|---|---|
| caveman | 01 (start) | mandatory, full orientation | linked-skills/caveman.md |
| gitnexus | 01, 02, 03, 04 | targeted lookup only | linked-skills/gitnexus.md |
| ce-debug | 04 | bug investigation child | linked-skills/ce-debug.md |
| ce-code-review | 04 | PR review or sanity-review child | linked-skills/ce-code-review.md |
| ce-resolve-pr-feedback | 04 | CodeRabbit or reviewer-feedback child | linked-skills/ce-resolve-pr-feedback.md |
| ce-simplify-code | 04 | scoped cleanup or refactor child | linked-skills/ce-simplify-code.md |
| ce-agent-native-architecture | 04 | Connect/Alice agent-native architecture child | linked-skills/ce-agent-native-architecture.md |
| caveman-compress | 07 | before stopping, handoff, or context risk | linked-skills/caveman-compress.md |

Supplementary policy:

- Caveman: full orientation only — confirm branch, parent, children, blockers, doctrine pointers. No broad traversal.
- GitNexus: targeted file/symbol lookup only. Not a report dump.
- docs-ingest: must not be used during evo-run.
- evo-plan: use only if the Linear parent is ambiguous, missing children, or not executable.
- ce-plan / ce-strategy: planning sessions only, not normal execution.

## Execution reporting

Invoke caveman-full at session start. It governs all user-facing responses for the duration of the run.

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <files / artifacts / branches / issues> or none
Validated: <commands / checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full regardless of caveman mode:
- Generated code
- Generated document or spec content
- Safety warnings
- Conflict escalation
- Irreversible-action confirmations
- Blocker descriptions (must be fully explicit)
- Acceptance-criteria gap explanations
