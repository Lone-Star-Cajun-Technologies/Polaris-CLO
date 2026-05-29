---
name: docs-promote
description: Review docs in smartdocs/docs/raw/ and smartdocs/docs/doctrine/candidate/ against linked code and active doctrine, then promote or deprecate using the Polaris CLI. Requires agent judgment — reads linked source areas, surfaces conflicts, and calls promote/deprecate only with explicit confirmation.
---

# docs-promote

Use this skill when documents have been ingested and need to be reviewed for promotion to an active authority tier, or when active docs need to be deprecated in response to code changes.

## When to use

- "Review the candidates and promote anything ready"
- "Promote the spec for the dispatch contract"
- "Deprecate the old architecture doc — it's been superseded"
- "Check what doctrine candidates are ready to promote"
- "A raw spec needs to go active before we start implementation"

## How to execute

1. Read `chain.md` — step order, review rules, CLI commands, conflict handling.
2. Read `.taskchain_artifacts/docs-promote/current-state.json` — resumable state.
3. Execute steps in the order `chain.md` defines. Do not skip steps.
4. After every completed step, update `current-state.json` before advancing.

## Hard rules — what docs-promote may do

- Read `smartdocs/docs/raw/` and `smartdocs/docs/doctrine/candidate/` to identify promotion candidates
- Read linked source files (from `linkedMapArea` in provenance sidecar) to verify relevance and staleness
- Read `smartdocs/docs/doctrine/active/` and `smartdocs/docs/specs/active/` to check for conflicts
- Call `npm run polaris -- doctrine spec-promote <path>` to surface the conflict report (without `--approve`)
- Call `npm run polaris -- doctrine spec-promote <path> --approve` **only after** surfacing the report and receiving explicit user confirmation
- Call `npm run polaris -- doctrine promote <path>` for doctrine candidates that pass governance checks
- Call `npm run polaris -- doctrine deprecate <path>` for active docs that are superseded or stale
- Emit telemetry events

## Hard rules — what docs-promote must NOT do

- Auto-promote without surfacing the conflict report first
- Call `--approve` without explicit user confirmation in the session
- Mutate source files (`src/`, tests, config)
- Call `npm run polaris -- loop continue` or `npm run polaris -- finalize`
- Promote to `architecture/` or `decisions/` — those require explicit ADR process
- Suppress or ignore detected conflicts

**Docs-promote reviews and surfaces. It does not promote silently or bypass the approval gate.**
