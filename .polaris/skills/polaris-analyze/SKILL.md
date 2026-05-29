---
name: polaris-analyze
description: Audit one Polaris issue against the actual repo using a configured repo-analysis provider (if available) and targeted inspection, then produce an ordered execution plan and cluster artifacts. Analysis and planning only — no code changes, no implementation execution.
role: analyst
role_file: .polaris/roles/analyst.md
---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```
npm run polaris -- skill packet analyze
```

- Do not begin work until a packet is returned.
- Treat the packet as your authoritative instruction source.
- The packet defines your active role, authority boundaries, prohibited actions, deliverables, and stop conditions.
- If no packet is produced, stop and report: **Polaris could not authorize this run.**

---

# polaris-analyze

Use this skill when the user asks to analyze or break down a Polaris issue before execution.

## Related doctrine

See `docs/Polaris/spec/polaris-implementation-plan.md` for the Polaris architecture reference.

## When to use

- "Analyze POL-XXX before running it"
- "Break down POL-XXX into child issues"
- "Is POL-XXX ready to execute?"
- "Plan the execution clusters for POL-XXX"

## How to execute

1. Read `chain.md` — it defines the step order and traversal rules.
2. Read `.taskchain_artifacts/polaris-analyze/current-state.json` — it contains any resumable state.
3. Execute steps in the order `chain.md` defines. Do not skip steps.
4. After every completed step, update `.taskchain_artifacts/polaris-analyze/current-state.json` before advancing.

## Hard rules — what analyze may do

- Inspect repo files and architecture
- Query the configured repo-analysis provider for code intelligence (if available; falls back to polaris map query + ripgrep)
- Summarize findings and assess feasibility
- Create implementation plans and specs (in `docs/`)
- Create or update tracker child issues (Linear)
- Generate local cluster artifacts (`.polaris/clusters/<id>/clusters.json`)
- Update tracker comments and status
- Close the analysis issue when complete

## Hard rules — what analyze must NOT do

- Implement production or runtime code
- Mutate source files (`src/`, tests, config)
- Execute implementation loops
- Open implementation PRs
- Continue automatically into polaris-run execution
- Call `polaris loop continue` or `polaris finalize`

**Analyze shapes work. Run executes work.**

If implementation execution is attempted during an analyze session: halt immediately and report the boundary violation.
