---
name: polaris-docs-ingest-chain
description: Route map for polaris-docs-ingest — step order, stop conditions, authority levels, canonical target doctrine, and artifact requirements.
---

# polaris-docs-ingest chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer ingest scope or prior progress from conversation context.

## CLI

Always use the repo-local Polaris CLI:

```
npm run polaris -- docs ingest [--file <path>] [--batch <cluster-id>] [--dry-run]
```

Drop zone: `smartdocs/docs/raw/` — this is the single ingest entry point.

Never assume a globally linked `polaris` command exists.

## Canonical Smart Docs target

`smartdocs/docs/` is the authoritative Smart Docs ingest target. There is one drop zone: `smartdocs/docs/raw/`.

- Root `docs/` is legacy/non-canonical — do not write new Smart Docs there.
- There are no sub-raw folders (`specs/raw/`, `doctrine/raw/`, `audits/raw/` do not exist). All drops land in `smartdocs/docs/raw/` and are routed from there.

**Architectural intent:** Smart Docs exist to reduce repo-understanding token burn. Agents should move from:

```
read many files → infer architecture
```

to:

```
read Smart Docs router → read local POLARIS.md → open only necessary files
```

Smart Docs function as architectural compression, routing context, local subsystem summaries, and implementation guidance boundaries — without replacing canonical source files.

## Step traversal order

```text
01-orient-ingest     ← generate run_id, emit telemetry, load batch, confirm canonical target
02-classify-batch    ← content analysis + front-matter, assign classification per file
03-conflict-check    ← compare against doctrine/active/ and specs/active/; halt on contradiction
04-place-and-link    ← move files to authority buckets, write provenance, update map
05-finalize-ingest   ← emit completion telemetry, update state, report placement summary
```

## Stop conditions

**Any step:**
- Conflict directly contradicts active doctrine → halt, report, require user resolution
- High-authority placement attempted (`doctrine/active/`, `architecture/`, `decisions/`) without explicit approval → halt and surface for review
- `Polaris-Docs/docs/` not found → halt, report missing canonical target
- `run-start` telemetry write fails → halt

**Step 03 (conflict check):**
- Direct doctrine contradiction → halt with conflict report
- Overlapping spec scope → flag as candidate supersede; continue with warning

## Authority levels

| Area | Authority | Who may write | Promotion path |
|---|---|---|---|
| `smartdocs/docs/raw/` | none | any agent freely | `polaris doctrine draft` → `doctrine/candidate/` or `polaris doctrine spec-promote` → `specs/active/` |
| `smartdocs/docs/runtime/` | low | polaris-run, polaris-finalize | no promotion; informational only |
| `smartdocs/docs/specs/active/` | medium | `polaris doctrine spec-promote --approve` only | moved to `implemented/` or `superseded/` |
| `smartdocs/docs/doctrine/candidate/` | low | docs ingest + `polaris doctrine draft` | `polaris doctrine promote` (user-approved) |
| `smartdocs/docs/doctrine/active/` | high | `polaris doctrine promote` (user-approved) | `polaris doctrine deprecate` (user-approved) |
| `smartdocs/docs/architecture/` | high | user-approved only | explicit ADR process |
| `smartdocs/docs/decisions/` | high | user-approved only | explicit ADR process |

## Run ID format

Format: `polaris-docs-ingest-<slug>-<date>-<seq>`
- `<slug>`: 2–4 lowercase hyphenated words from the ingest context. No issue IDs.
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `polaris-docs-ingest-compact-contracts-2026-05-26-001`

## Telemetry

Telemetry file: `.taskchain_artifacts/polaris-docs-ingest/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Trigger |
|---|---|
| `run-start` | Begin processing |
| `step-complete` | End of every step |
| `docs-ingest-classified` | Each file classified |
| `docs-ingest-conflict-detected` | Conflict found against active doctrine or spec |
| `doctrine-candidate-proposed` | Doc routed to `doctrine/candidate/` |
| `docs-ingest-stale-assumption` | Stale assumption annotated in front-matter |
| `docs-ingest-complete` | Batch done |

Required fields on every event: `event`, `run_id`, `timestamp`. Add `file` where applicable.

## Context budget

One ingest cluster per session. Default batch: 3–4 files. Configurable:

```json
{ "docs": { "ingestBatchSize": 4 } }
```

Stop after completing one cluster. Bootstrap packet guidance directs the next session to the next pending cluster.

## Artifact authority

`.taskchain_artifacts/polaris-docs-ingest/current-state.json` is the sole authoritative live state surface.

- Update after every completed step — before advancing.
- A step is NOT complete until the state update succeeds.
- If the update fails: stop and report the persistence failure.

## Linked-skill invocation boundaries

| Skill | Allowed steps | Condition |
|---|---|---|
| repo-analysis | 01, 02 | targeted lookup only; for code-area linking |

## Execution reporting

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <files moved / provenance records written / map entries updated> or none
Validated: <conflict checks / authority checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full:
- Conflict reports and resolution requirements

- Doctrine candidate proposals
- Stale-assumption annotations
- Authority violation warnings
- Final placement summary
