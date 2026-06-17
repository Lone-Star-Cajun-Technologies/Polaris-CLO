---
name: docs-promote-chain
description: Route map for docs-promote — step order, CLI reference, canonical paths, run ID format, telemetry, and artifact authority. Step detail lives in steps/.
---

# docs-promote chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer promotion readiness from conversation context.

## Step traversal order

```text
01-orient-promote
02-review-candidates
03-read-linked-code
04-conflict-surface
05-await-approval
06-execute-promote-deprecate
07-finalize-promote
```

Read the current step's file in `steps/` before acting. Do not read ahead.

## CLI

Always use the repo-local Polaris CLI:

```
polaris doctrine draft <path>
polaris doctrine promote <path>
polaris doctrine deprecate <path>
polaris doctrine spec-promote <path>
polaris doctrine spec-promote <path> --approve
```

Never assume a globally linked `polaris` command exists.

## Canonical paths

| State | Path |
|---|---|
| Drop zone | `smartdocs/raw/` |
| Doctrine staging | `smartdocs/doctrine/candidate/` |
| Active doctrine | `smartdocs/doctrine/active/` |
| Deprecated doctrine | `smartdocs/doctrine/deprecated/` |
| Active specs | `smartdocs/specs/active/` |
| Implemented specs | `smartdocs/specs/implemented/` |
| Superseded specs | `smartdocs/specs/superseded/` |

## Run ID format

`docs-promote-<slug>-<YYYY-MM-DD>-<seq>` — e.g. `docs-promote-dispatch-contract-2026-05-29-001`

## Telemetry

File: `.taskchain_artifacts/docs-promote/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Trigger |
|---|---|
| `run-start` | Begin processing |
| `step-complete` | End of every step |
| `docs-promote-conflict-report` | Conflict check result per candidate |
| `docs-promote-approved` | User approved a promotion |
| `docs-promote-rejected` | User rejected a promotion |
| `docs-promoted` | Successful promote/deprecate command |
| `docs-promote-complete` | All candidates processed |

Required fields: `event`, `run_id`, `timestamp`. Add `file` where applicable.

## Artifact authority

`.taskchain_artifacts/docs-promote/current-state.json` is the sole authoritative live state surface.

- Update after every completed step — before advancing.
- A step is NOT complete until the state update succeeds.
- If the update fails: stop and report the persistence failure.
