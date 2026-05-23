---
name: polaris-run-chain
description: Route map for polaris-run — step order, continuation rules, and artifact update requirements.
---

# polaris-run chain

## Step traversal order

```text
01-orient-cluster
02-select-child          ← loops back here after 05 decides CONTINUE
03-execute-child
04-commit-and-update-linear
05-advance-loop          → CONTINUE: go to 02 | STOP: halt and report | FINALIZE: run polaris finalize
```

## Continuation rules

After step 05 evaluates the session:

- **CONTINUE**: return to step 02 within the same session. Do not re-orient — use existing state.
- **STOP (budget)**: halt cleanly when any context budget threshold is met. Report completed child, commit hash, next open child ID, and the resume command: `polaris loop resume`.
- **STOP (blocked)**: follow the blocker protocol in step 04. Halt immediately. Do not skip to later children.
- **FINALIZE**: run `polaris finalize` when `open_children` is empty and all children are Done.

## Context budget

Track in `.polaris/runs/current-state.json` under `context_budget`. Update after each child completes.

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 3 → STOP |

## Artifact update requirement

After every completed step, update `.polaris/runs/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.polaris/runs/current-state.json` updated successfully.

If the artifact update fails, stop immediately and report the failure.

## Run ID format

Format: `polaris-run-<slug>-<date>-<seq>` where:
- `<slug>` is 2–4 lowercase hyphenated words from the cluster title (no Linear IDs in the slug)
- `<date>` is `YYYY-MM-DD`
- `<seq>` is a zero-padded sequential number per day (001, 002, …)

Example: `polaris-run-loop-boundary-2026-05-23-001`

Resumed sessions generate a new `run_id` and record the prior one in `current-state.json`.

## Telemetry

Each run produces an append-only JSONL file:

```
.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl
```

Set `artifact_dir: ".taskchain_artifacts/polaris-run"` in `current-state.json` so the CLI commands resolve the telemetry path correctly.

| Event | Emitted by | When |
|---|---|---|
| `run-start` | agent (step 01) | First action — before any Linear access or branch work |
| `loop-checkpoint` | `polaris loop continue` | After each child completes (step 05) |
| `analyze-impl-boundary-enforced` | `polaris loop continue` | When boundary fires (step 05) |
| `loop-aborted` | `polaris loop abort` | On any blocker halt |
| `pr-opened` | `polaris finalize` | Finalize step 10 |
| `run-complete` | `polaris finalize` | Finalize step 10 |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Chain definition

Each cluster's children, types, and dependency order are defined in:

```
.polaris/clusters/<cluster-id>/chain.yaml
```

This file must exist before a first session can start. See `.polaris/clusters/chain-yaml-format.md` for the schema.
