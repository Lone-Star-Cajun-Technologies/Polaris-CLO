---
name: polaris-analyze-chain
description: Route map for polaris-analyze — step order, boundary enforcement, and artifact update requirements.
---

# polaris-analyze chain

## Step traversal order

```text
01-orient-cluster
02-select-child          ← loops back here after 05 decides CONTINUE
03-execute-child
04-commit-and-update-linear
05-advance-loop          → CONTINUE: go to 02 | BOUNDARY: halt (implement next) | FINALIZE: polaris finalize
```

## Continuation rules

After step 05:

- **CONTINUE**: return to step 02 within the same session. Next child must be `session_type: analyze`.
- **BOUNDARY**: halt when `polaris loop continue` fires the analyze→implement boundary enforcement event. Report the last completed analyze child and the first implement child. The operator must start a new polaris-run session.
- **STOP (budget)**: halt when context budget threshold is met. Report next open child and resume command: `polaris loop resume`.
- **FINALIZE**: run `polaris finalize` only when ALL cluster children (analyze and implement) are Done. This case applies only to analyze-only clusters.

## Context budget

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 3 → STOP |

## Scope enforcement

`polaris loop continue` reads `.polaris/session-type` to detect non-doc file mutations in the working tree. If implementation-scope changes are found, it halts with a scope violation event. This is structural enforcement — the skill does not replicate it manually.

## Artifact update requirement

After every completed step, update `.polaris/runs/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.polaris/runs/current-state.json` updated successfully.

## Run ID format

Format: `polaris-analyze-<slug>-<date>-<seq>` where:
- `<slug>` is 2–4 lowercase hyphenated words from the cluster title (no Linear IDs in the slug)
- `<date>` is `YYYY-MM-DD`
- `<seq>` is a zero-padded sequential number per day (001, 002, …)

Example: `polaris-analyze-local-instructions-2026-05-23-001`

Resumed sessions generate a new `run_id` and record the prior one in `current-state.json`.

## Telemetry

Each run produces an append-only JSONL file:

```
.taskchain_artifacts/polaris-analyze/runs/<run-id>/telemetry.jsonl
```

Set `artifact_dir: ".taskchain_artifacts/polaris-analyze"` in `current-state.json` so the CLI commands resolve the telemetry path correctly.

| Event | Emitted by | When |
|---|---|---|
| `run-start` | agent (step 01) | First action — before any Linear access or branch work |
| `loop-checkpoint` | `polaris loop continue` | After each child completes (step 05) |
| `analyze-impl-boundary-enforced` | `polaris loop continue` | When boundary fires (step 05) |
| `loop-aborted` | `polaris loop abort` | On any blocker halt |
| `run-complete` | `polaris finalize` | Finalize step 10 (analyze-only clusters only) |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Chain definition

Each cluster's children, types, and dependency order are defined in:

```
.polaris/clusters/<cluster-id>/chain.yaml
```

This file must exist before a first session can start. See `.polaris/clusters/chain-yaml-format.md` for the schema.
