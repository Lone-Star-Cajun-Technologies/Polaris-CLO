---
name: docs-triage
description: Detect contradictions, duplicates, and stale code references among candidate docs by comparing them against canonicals via LLM batch calls and graph symbol lookup. Writes a triage queue for human review via polaris docs review.
role: librarian
role_file: .polaris/roles/librarian.md
---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```
polaris skill packet triage
```

- Do not begin work until a packet is returned.
- Treat the packet as your authoritative instruction source.
- The packet defines your active role, authority boundaries, prohibited actions, deliverables, and stop conditions.
- If no packet is produced, stop and report: **Polaris could not authorize this run.**

---

# docs-triage

Use this skill when candidate docs need to be screened for conflicts, duplicates, and stale symbol references before human review.

## When to use

- "Run docs triage"
- "Triage the candidate docs"
- "Find contradictions among the candidates"
- "Check for stale code references in candidates"
- "Run a dry-run triage to see the estimate"

## How to execute

1. Read `chain.md` — step order, traversal rules, output contract.
2. Execute steps in the order `chain.md` defines. Do not skip steps.
3. After triage completes, hand off to `polaris docs review` for human decisions.

## Hard rules — what docs-triage may do

- Read canonicals from `smartdocs/doctrine/active/`
- Read candidates from `smartdocs/doctrine/candidate/`
- Call `polaris docs triage [--dry-run] [--batch-size N] [--resume]`
- Read `smartdocs/raw/_triage-queue.json` and `_triage-report.md`
- Emit telemetry events

## Hard rules — what docs-triage must NOT do

- Move, promote, or delete any document — triage produces flags only
- Mutate source files (`src/`, tests, config)
- Call `polaris loop continue` or `polaris finalize`
- Auto-approve or auto-reject any triage flag without human review

**Docs-triage flags. It does not decide.**
