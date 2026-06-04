---
name: polaris-reconcile
description: Update POLARIS.md and SUMMARY.md files to reflect completed work. Callable at will — does not require a cluster closeout. Uses the Polaris packet for work context.
role: librarian
---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```bash
npm run polaris -- skill packet reconcile
```

- Do not begin work until a packet is returned.
- Treat the packet as your authoritative instruction source.
- If no packet is produced, stop and report: **Polaris could not authorize this run.**

---

# polaris-reconcile

Use this skill to reconcile project cognition after completed work — updating POLARIS.md and
SUMMARY.md files to reflect current reality. This is the standalone form of the cognition
reconciliation steps performed by the Closeout Librarian, callable at will rather than only
at cluster closeout.

## When to use

- "Reconcile the docs after POL-257"
- "Update POLARIS.md and SUMMARY.md for this run"
- "Run polaris-reconcile on POL-303"
- After a run completes and you want cognition updated without waiting for full closeout

## How to execute

1. Read `chain.md` — step order and rules.
2. Read `.taskchain_artifacts/polaris-reconcile/current-state.json` — resumable state.
3. Execute steps in the order `chain.md` defines. Do not skip steps.
4. After every completed step, update `current-state.json` before advancing.

## Hard rules — what polaris-reconcile may do

- Read packet-specified folders and their POLARIS.md and SUMMARY.md files
- Write POLARIS.md and SUMMARY.md files within `packet.allowed_write_paths`
- Create a single sealed git commit of all cognition changes

## Hard rules — what polaris-reconcile must NOT do

- Modify implementation source code (`src/`, tests, config)
- Modify runtime state files outside this skill's owned artifacts (cluster-state, other skills' `.taskchain_artifacts/` state, or non-reconcile telemetry)
- Move, ingest, classify, or promote documents
- Call `npm run polaris -- loop continue` or `npm run polaris -- finalize`
- Write to `packet.prohibited_write_paths`
- Git push or create PRs

## Packet schema

The packet is a `ReconcilePacket`. Required fields:

| Field | Description |
|---|---|
| `run_id` | Identifier for this reconcile run |
| `issue_id` | Bound issue (e.g. `POL-257`) |
| `affected_folders` | Folders whose POLARIS.md and/or SUMMARY.md may need updating |
| `work_inventory` | Summary of completed work: changed files, child summaries, cognition notes |
| `allowed_write_paths` | Paths this skill may write |
| `prohibited_write_paths` | Paths this skill must not write |
| `constraints.max_summary_addition_lines` | Net new line cap per SUMMARY.md update (default: 50) |

## Execution

Read `chain.md` and execute steps in strict order. Do not skip steps. Do not reorder steps.
