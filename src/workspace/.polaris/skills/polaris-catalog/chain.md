---
name: polaris-catalog-chain
description: Step order, CLI reference, canonical paths, run ID format, telemetry, and artifact authority for polaris-catalog.
---

# polaris-catalog chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer affected folders, doc classifications, or
change scope from conversation context.

## Step traversal order

```text
01-orient-catalog
02-reconcile-polaris-md
03-reconcile-summary-md
04-classify-and-place
05-catalog-commit
```

Read the current step's file in `steps/` before acting. Do not read ahead.

## CLI

Always use the repo-local Polaris CLI:

```
polaris docs ingest --file <path>
polaris doctrine draft <path>
polaris map update --changed
```

Never assume a globally linked `polaris` command exists.

## Canonical paths

| State | Path |
|---|---|
| Doc drop zone | `smartdocs/raw/` |
| Skill state | `.taskchain_artifacts/polaris-catalog/current-state.json` |
| Telemetry | `.taskchain_artifacts/polaris-catalog/runs/<run-id>/telemetry.jsonl` |

## Run ID format

`polaris-catalog-<slug>-<YYYY-MM-DD>-<seq>` — e.g. `polaris-catalog-POL-257-2026-06-04-001`

## Telemetry

Append-only JSONL. Required fields: `event`, `run_id`, `timestamp`.

| Event | Trigger |
|---|---|
| `run-start` | Begin orient step |
| `step-complete` | End of every step |
| `polaris-md-updated` | POLARIS.md written for a folder |
| `summary-md-updated` | SUMMARY.md written for a folder |
| `doc-classified` | Classification assigned per file in raw |
| `doc-placed` | File moved via CLI |
| `doc-held` | Low-confidence file left in raw |
| `catalog-commit` | Commit created |
| `catalog-complete` | All steps done |

## Artifact authority

`.taskchain_artifacts/polaris-catalog/current-state.json` is the sole authoritative
live state surface.

- Update after every completed step — before advancing.
- A step is NOT complete until the state update succeeds.
- If the update fails: stop and report the persistence failure.

## Forbidden actions

- src file mutations
- runtime state file mutations
- polaris loop continue
- polaris finalize
- git push
- PR creation
- mv/cp on files under smartdocs/ (use CLI)
- auto-placing low-confidence files
