---
name: docs-review
description: Agentically review the triage queue — read each flagged candidate doc, evaluate the flag, and record approve/reject/defer decisions. Applies approved and rejected decisions via polaris docs ingest.
role: librarian
role_file: .polaris/roles/librarian.md
---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```
polaris skill packet review
```

- Do not begin work until a packet is returned.
- Treat the packet as your authoritative instruction source.
- The packet defines your active role, authority boundaries, prohibited actions, deliverables, and stop conditions.
- If no packet is produced, stop and report: **Polaris could not authorize this run.**

---

# docs-review

Use this skill to agentically walk through the triage queue and make approve/reject/defer decisions on each flagged candidate document. You are the reviewer — read each doc, evaluate the flag, and decide.

## When to use

- "Run docs review"
- "Review the triage queue"
- "Process the flagged candidates"
- "docs-review"

## How to execute

1. Read `chain.md` — step order, traversal rules, output contract.
2. Execute steps in the order `chain.md` defines. Do not skip steps.
3. You make all decisions by reading the flagged doc content and the flag metadata.

## Hard rules — what docs-review may do

- Read `smartdocs/raw/_triage-queue.json` to load pending items
- Read candidate documents from `smartdocs/doctrine/candidate/`
- Record decisions (approve/reject/defer) back to `_triage-queue.json`
- Call `polaris docs ingest` to apply approved/rejected decisions
- Emit telemetry events

## Hard rules — what docs-review must NOT do

- Move, rename, or delete documents directly — ingest handles that
- Auto-approve every packet without reading the document
- Mutate source files (`src/`, tests, config)
- Call `polaris loop continue` or `polaris finalize`
- Skip packets without recording a decision

**Docs-review reads, evaluates, and decides. Ingest executes.**
