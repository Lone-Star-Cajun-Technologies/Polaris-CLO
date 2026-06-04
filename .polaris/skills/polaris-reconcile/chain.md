---
name: polaris-reconcile-chain
description: Step order, CLI reference, canonical paths, run ID format, telemetry, and artifact authority for polaris-reconcile.
---

# polaris-reconcile chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer affected folders or change scope from
conversation context.

## Step traversal order

```text
01-orient-reconcile
02-reconcile-polaris-md
03-reconcile-summary-md
04-reconcile-commit
```

Read the current step's file in `steps/` before acting. Do not read ahead.

## Canonical paths

| State | Path |
|---|---|
| Skill state | `.taskchain_artifacts/polaris-reconcile/current-state.json` |
| Telemetry | `.taskchain_artifacts/polaris-reconcile/runs/<run-id>/telemetry.jsonl` |

## Run ID format

`polaris-reconcile-<slug>-<YYYY-MM-DD>-<seq>` — e.g. `polaris-reconcile-POL-257-2026-06-04-001`

## Telemetry

Append-only JSONL. Required fields: `event`, `run_id`, `timestamp`.

| Event | Trigger |
|---|---|
| `run-start` | Begin orient step |
| `step-complete` | End of every step |
| `polaris-md-updated` | POLARIS.md written for a folder |
| `summary-md-updated` | SUMMARY.md written for a folder |
| `reconcile-commit` | Commit created |
| `reconcile-complete` | All steps done |

## Artifact authority

`.taskchain_artifacts/polaris-reconcile/current-state.json` is the sole authoritative
live state surface.

- Update after every completed step — before advancing.
- A step is NOT complete until the state update succeeds.
- If the update fails: stop and report the persistence failure.

## Forbidden actions

- src file mutations
- runtime state file mutations
- document ingestion or promotion
- polaris loop continue
- polaris finalize
- git push
- PR creation
