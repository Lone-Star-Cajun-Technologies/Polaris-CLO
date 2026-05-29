---
name: docs-promote-chain
description: Route map for docs-promote — step order, review rules, CLI commands, conflict handling, and approval gate.
---

# docs-promote chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer promotion readiness from conversation context.

## CLI

Always use the repo-local Polaris CLI:

```
# Draft a raw doc into doctrine candidate staging
npm run polaris -- doctrine draft <path>

# Promote a doctrine candidate to active (requires governance front-matter)
npm run polaris -- doctrine promote <path>

# Deprecate an active doctrine doc
npm run polaris -- doctrine deprecate <path>

# Surface spec promotion conflict report (no --approve = dry gate only)
npm run polaris -- doctrine spec-promote <path>

# Execute spec promotion after user approval
npm run polaris -- doctrine spec-promote <path> --approve
```

Never assume a globally linked `polaris` command exists.

## Canonical paths

| State | Path |
|---|---|
| Drop zone (ingest output) | `smartdocs/docs/raw/` |
| Doctrine staging | `smartdocs/docs/doctrine/candidate/` |
| Active doctrine | `smartdocs/docs/doctrine/active/` |
| Deprecated doctrine | `smartdocs/docs/doctrine/deprecated/` |
| Active specs | `smartdocs/docs/specs/active/` |
| Implemented specs | `smartdocs/docs/specs/implemented/` |
| Superseded specs | `smartdocs/docs/specs/superseded/` |

## Step traversal order

```text
01-orient-promote      ← generate run_id, emit telemetry, load candidate list, confirm canonical target
02-review-candidates   ← list docs in raw/ and doctrine/candidate/; read provenance sidecars for linkedMapArea
03-read-linked-code    ← for each candidate, read the linked source area (from linkedMapArea); check for staleness
04-conflict-surface    ← run spec-promote (without --approve) or check doctrine governance fields; capture full report
05-await-approval      ← present conflict report + linked-code findings to user; STOP and wait for explicit approval
06-execute-promote-deprecate ← on approval: call promote/deprecate commands; on rejection: record decision in state
07-finalize-promote    ← emit completion telemetry, update state, report what was promoted/deprecated/held
```

## Step rules

### 01 — orient-promote
- Generate `run_id` using format: `docs-promote-<slug>-<date>-<seq>`
- Emit `run-start` telemetry
- Load `current-state.json` — if a prior run is in progress, resume from last completed step
- Confirm `smartdocs/docs/` exists; halt if missing

### 02 — review-candidates
- List `smartdocs/docs/raw/*.md` and `smartdocs/docs/doctrine/candidate/*.md`
- For each, read the co-located `.provenance.json` sidecar if present
- Extract `linkedMapArea`, `classifiedAs`, `ingestedAt`
- Record candidate list in state

### 03 — read-linked-code
- For each candidate with a `linkedMapArea`, read the linked source directory's `POLARIS.md` and up to 3 key source files
- Determine:
  - Is the linked area still active in the codebase?
  - Has the code evolved past the doc's assumptions?
  - Does the doc's content still reflect what the code does?
- Record relevance verdict (`current` / `stale` / `superseded`) per candidate in state

### 04 — conflict-surface
- **For raw specs**: run `npm run polaris -- doctrine spec-promote <path>` (no `--approve`)
  - Capture stdout — this is the full conflict report
- **For doctrine candidates**: check that front-matter contains all required governance fields (`doc-type`, `confidence`, `recommended-action`, `overlap-analysis`) and `recommended-action: promote`
  - If fields missing or `recommended-action` is not `promote`: mark as `needs-governance-update`
- **For active docs to deprecate**: confirm the doc's `linkedMapArea` code is gone or superseded
- Emit `docs-promote-conflict-report` telemetry for each candidate

### 05 — await-approval
- **This step always stops for user input.**
- Present a summary table:

```text
| File | Type | Linked Area | Conflicts | Relevance | Recommended Action |
```

- Do not proceed to step 06 without explicit user confirmation (`yes`, `approve`, `--approve`, or equivalent)
- If user says no or requests changes: record decision in state, go to step 07

### 06 — execute-promote-deprecate
- For each approved promotion:
  - **Spec**: `npm run polaris -- doctrine spec-promote <path> --approve`
  - **Doctrine**: `npm run polaris -- doctrine promote <path>`
  - **Deprecate**: `npm run polaris -- doctrine deprecate <path>`
- Record result (promoted path, errors) in state after each command
- If any command fails: halt and report; do not attempt remaining commands

### 07 — finalize-promote
- Update `current-state.json` with final outcomes
- Emit `docs-promote-complete` telemetry
- Print summary: promoted, deprecated, held, and why

## Stop conditions

**Any step:**
- `smartdocs/docs/` not found → halt
- `run-start` telemetry write fails → halt
- Any CLI command exits non-zero → halt and report

**Step 05:**
- No user confirmation received → stay in step 05; do not auto-advance

**Step 06:**
- Any promote/deprecate command fails → halt immediately; do not continue batch

## Run ID format

Format: `docs-promote-<slug>-<date>-<seq>`
- `<slug>`: 2–4 lowercase hyphenated words from the promotion context
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `docs-promote-dispatch-contract-2026-05-29-001`

## Telemetry

Telemetry file: `.taskchain_artifacts/docs-promote/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Trigger |
|---|---|
| `run-start` | Begin processing |
| `step-complete` | End of every step |
| `docs-promote-conflict-report` | Conflict check result per candidate |
| `docs-promote-approved` | User approved a promotion |
| `docs-promote-rejected` | User rejected a promotion |
| `docs-promoted` | Successful promote/deprecate command |
| `docs-promote-complete` | All candidates processed |

Required fields on every event: `event`, `run_id`, `timestamp`. Add `file` where applicable.

## Artifact authority

`.taskchain_artifacts/docs-promote/current-state.json` is the sole authoritative live state surface.

- Update after every completed step — before advancing.
- A step is NOT complete until the state update succeeds.
- If the update fails: stop and report the persistence failure.

## Execution reporting

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <files promoted / deprecated / held> or none
Validated: <conflict checks / governance checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full:
- Conflict reports and resolution requirements
- Governance field validation failures
- Linked-code staleness findings
- User approval gate output
- Final promotion summary
