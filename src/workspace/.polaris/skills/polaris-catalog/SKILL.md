---
name: polaris-catalog
description: Combined cognition reconciliation and document classification. Updates POLARIS.md and SUMMARY.md from the packet, then classifies documents in smartdocs/raw/ — auto-placing high-confidence files and asking the user (or leaving in raw when unattended) for low-confidence ones.
role: librarian
---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```bash
npm run polaris -- skill packet catalog
```

- Do not begin work until a packet is returned.
- Treat the packet as your authoritative instruction source.
- If no packet is produced, stop and report: **Polaris could not authorize this run.**

---

# polaris-catalog

Use this skill to perform a full cognition and documentation pass after completed work.
It combines the cognition reconciliation of `polaris-reconcile` with document classification
from `smartdocs/raw/`.

`polaris-catalog` is the callable-at-will equivalent of what the Closeout Librarian does
for cognition + ingestion, without requiring a cluster closeout.

## When to use

- "Catalog the docs after POL-257"
- "Run polaris-catalog on POL-303"
- After a run completes and you want a full cognition + docs pass in one invocation
- In CI or automated contexts where both reconciliation and doc classification should run together

## How to execute

1. Read `chain.md` — step order and rules.
2. Read `.taskchain_artifacts/polaris-catalog/current-state.json` — resumable state.
3. Execute steps in the order `chain.md` defines. Do not skip steps.
4. After every completed step, update `current-state.json` before advancing.

## Classification behavior

- **High confidence** — auto-place via CLI. No pause, no user input required.
- **Low confidence (interactive)** — surface each file and ask the user where it should go.
- **Low confidence (unattended/CI)** — leave in `smartdocs/raw/` and include in the final report. Do not block. Do not fail.

The `packet.unattended` flag controls which low-confidence behavior applies.

## Hard rules — what polaris-catalog may do

- Read packet-specified folders and their POLARIS.md and SUMMARY.md files
- Write POLARIS.md and SUMMARY.md files within `packet.allowed_write_paths`
- Read `smartdocs/raw/` to enumerate documents for classification
- Call `npm run polaris -- docs ingest --file <path>` to place classified documents
- Call `npm run polaris -- doctrine draft <path>` for doctrine candidates
- Call `npm run polaris -- map update --changed` after batch placement
- Create a single sealed git commit of all cognition and doc changes

## Hard rules — what polaris-catalog must NOT do

- Modify implementation source code (`src/`, tests, config)
- Modify runtime state files outside this skill's owned artifacts (cluster-state, other skills' `.taskchain_artifacts/` state, or non-catalog telemetry)
- Call `npm run polaris -- loop continue` or `npm run polaris -- finalize`
- Write to `packet.prohibited_write_paths`
- Git push or create PRs
- Auto-place low-confidence files (always leave in raw or ask)
- Move files under `smartdocs/` directly with `mv` or `cp` — use the CLI

## Packet schema

The packet is a `CatalogPacket`. Required fields:

| Field | Description |
|---|---|
| `run_id` | Identifier for this catalog run |
| `issue_id` | Bound issue (e.g. `POL-257`) |
| `affected_folders` | Folders whose POLARIS.md and/or SUMMARY.md may need updating |
| `work_inventory` | Summary of completed work: changed files, child summaries, cognition notes |
| `unattended` | Boolean — `true` means CI/automated context; low-confidence files left in raw |
| `allowed_write_paths` | Paths this skill may write |
| `prohibited_write_paths` | Paths this skill must not write |
| `constraints.max_summary_addition_lines` | Net new line cap per SUMMARY.md update (default: 50) |

## Execution

Read `chain.md` and execute steps in strict order. Do not skip steps. Do not reorder steps.
