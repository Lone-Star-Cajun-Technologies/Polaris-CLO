---
name: docs-ingest
description: Classify, route, and link documents from the raw drop zone into the canonical smartdocs/docs/ authority structure. Docs routing only — no source code changes, no implementation execution.
role: librarian
role_file: .polaris/roles/librarian.md
---

# docs-ingest

Use this skill when documents need to be classified and routed into the canonical Smart Docs hierarchy.

## When to use

- "Ingest the docs from the last run"
- "Classify the files in smartdocs/docs/raw/"
- "Route pending documents into the correct authority buckets"
- "Process ingest cluster docs-ingest-cluster-001"
- "Dry-run docs ingest to see what would move"

## How to execute

1. Read `chain.md` — step order, traversal rules, authority levels, canonical target doctrine.
2. Read `.taskchain_artifacts/docs-ingest/current-state.json` — resumable state.
3. Execute steps in the order `chain.md` defines. Do not skip steps.
4. After every completed step, update `current-state.json` before advancing.

## Hard rules — what docs-ingest may do

- Read documents from `smartdocs/docs/raw/`
- Classify documents by content analysis and front-matter
- Route documents to correct authority directories within `smartdocs/docs/`
- Write provenance records alongside placed files
- Update Polaris map entries to link docs to code areas
- Propose doctrine candidates (route to `doctrine/candidate/`; never promote to `doctrine/active/` without user approval)
- Emit telemetry events

## Hard rules — what docs-ingest must NOT do

- Write new Smart Docs to root `docs/` — `smartdocs/docs/` is the canonical target
- Silently promote documents to `doctrine/active/`, `specs/active/`, `architecture/`, or `decisions/`
- Mutate source files (`src/`, tests, config)
- Call `npm run polaris -- loop continue` or `npm run polaris -- finalize`
- Suppress detected conflicts

**Docs-ingest routes and classifies. It does not implement or promote without explicit approval.**
