---
name: docs-ingest
description: Deterministic graph-integrity workflow — ingests, classifies, normalizes, and places notes into the EVO docs system with artifact persistence and resumable execution.
---

# docs-ingest

Use this skill when files in `docs/raw/` need to be triaged and ingested, or when the docs graph requires integrity maintenance.

## How to execute

1. Read `chain.md` — it is the route map for this workflow.
2. Read `.taskchain_artifacts/docs-ingest/current-state.json` — it holds the shared runtime state across steps and sessions.
3. Execute one step at a time in the order chain.md specifies.
4. After each step completes, update `.taskchain_artifacts/docs-ingest/current-state.json` before moving to the next step.
5. Do not skip steps.
6. Do not report completion until `.taskchain_artifacts/docs-ingest/current-state.json` reports `status: complete`.

## Artifact authority rule

`.taskchain_artifacts/docs-ingest/current-state.json` is the authoritative run ledger, not an optional note.

A step is not complete until its state update has been written successfully.

If the artifact update fails or cannot be verified, stop and report the artifact failure instead of continuing.
