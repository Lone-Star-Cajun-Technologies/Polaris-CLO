---
name: polaris-run-chain
description: Route map for polaris-run — step order, continuation rules, Polaris runtime integration, and artifact update requirements.
---

# polaris-run chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer cluster scope or progress from conversation context.

## CLI

Always use the repo-local Polaris CLI:

```
npm run polaris -- <command>
```

Never assume a globally linked `polaris` command exists.

## Step traversal order

```text
01-orient-cluster
02-prepare-branch
03-select-child
04-execute-child
05-validate-child
06-commit-and-update-linear
07-decide-continuation   → CHECKPOINT + adapter handoff | STOP (blocked/all-done) | DELIVER: go to 08
08-final-delivery        ← reached when all children Done and delivery requested
```

## Continuation rules

After step 07 evaluates the session:

- **ADAPTER HANDOFF (child-complete)**: after one child completes, checkpoint state and hand the next child to the configured execution adapter. The parent/orchestrator reads only the compact state/telemetry summary; worker transcripts do not flow back into parent context.
- **STOP (blocked)**: halt immediately on blocker. Report unblock condition.
- **STOP (all-done, awaiting delivery)**: all children Done but delivery not yet requested. Report branch and last commit. Provide delivery command: `Use polaris-run on <PARENT-ID>. Finalize delivery.`
- **DELIVER**: proceed to step 08 only when all children are Done and the user explicitly requests delivery in this session invocation.

Interactive-agent mode uses an agent/subtask adapter, not shell nesting. Terminal/CI mode may use `scripts/polaris-run.sh` as the `terminal-cli` adapter.

## Polaris runtime integration

polaris-run augments the evo-run pattern with three Polaris-specific calls:

| Step | Polaris call | Purpose |
|---|---|---|
| 06 | `npm run polaris -- map update --changed` | Index files changed by the committed child |
| 07 | `npm run polaris -- loop continue` | Checkpoint state, emit JSONL event, generate bootstrap packet, enforce boundary |
| 08 | `npm run polaris -- finalize` | Push branch, open PR, append JSONL closeout events, archive run snapshot |

`npm run polaris -- loop continue` replaces manual STOP/CONTINUE evaluation — it reads `.polaris/session-type` and `current-state.json`, runs the boundary check, and emits the bootstrap packet. The skill reads the packet's compact output to determine whether to halt, deliver, or dispatch the next child through the configured execution adapter.

## Context budget

Track in `.taskchain_artifacts/polaris-run/current-state.json` under `context_budget`. Update after each child.

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 1 → adapter handoff or STOP |
| `files_touched_total` | Total files changed this session | > 50 → STOP (safety) |
| `last_child_files_touched` | Files changed by last child | > 20 → STOP (safety) |

## Run ID format

Format: `polaris-run-<slug>-<date>-<seq>`
- `<slug>`: 2–4 lowercase hyphenated words from the cluster title. No Linear IDs.
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `polaris-run-loop-boundary-2026-05-23-001`

Resumed sessions generate a new `run_id`. Record the prior in `related_run_id`.

## Telemetry enforcement

Telemetry file: `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Emitted by | Step |
|---|---|---|
| `run-start` | agent | 01 — before any Linear access |
| `step-complete` | agent | end of every step |
| `loop-checkpoint` | `npm run polaris -- loop continue` | 07 — after each child |
| `analyze-impl-boundary-enforced` | `npm run polaris -- loop continue` | 07 — if boundary fires |
| `loop-aborted` | `npm run polaris -- loop abort` | any blocker halt |
| `pr-opened` | `npm run polaris -- finalize` | 08 |
| `run-complete` | `npm run polaris -- finalize` | 08 |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Artifact authority

`.taskchain_artifacts/polaris-run/current-state.json` is the sole authoritative live state surface.

- Update after every completed step — before advancing.
- A step is NOT complete until the state update succeeds.
- If the update fails: stop and report the persistence failure.

## Machine snapshot

- **Path**: `.taskchain_artifacts/polaris-run/current-state.json`
- **Update requirement**: after every step
- **Purpose**: fast agent resume without replaying JSONL or markdown history

## Completion rule

Do not report workflow completion until `.taskchain_artifacts/polaris-run/current-state.json` has `status: complete`.

## Linked-skill invocation boundaries

| Skill | Allowed steps | Condition |
|---|---|---|
| caveman | 01 (start) | optional; explicitly enabled runs only — detection is not activation |
| repo-analysis | 01, 02, 03, 04 | targeted lookup only; conditional on provider availability |
| execution-adapter | 07 | required when a completed child has a next open child |

## Execution reporting

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
- Safety warnings
- Blocker descriptions
- Acceptance-criteria gap explanations
- Irreversible-action confirmations
