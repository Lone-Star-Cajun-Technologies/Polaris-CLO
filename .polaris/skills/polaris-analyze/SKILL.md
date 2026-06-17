---
name: polaris-analyze
description: Audit one Polaris issue against the actual repo using a configured repo-analysis provider (if available) and targeted inspection, then produce an ordered execution plan and cluster artifacts. Analysis and planning only — no code changes, no implementation execution.
role: analyst
role_file: .polaris/roles/analyst.md
---

## Command entrypoints

This skill is the target for the following user commands:

- `polaris-analyze <POL-###>`
- `run polaris-analyze on issue <POL-###>`
- `run polaris-analyze on <POL-###>`

When any of these commands are issued, load this skill packet **first** before any other action.
Bind the named issue exactly as specified. See `.polaris/skills/ROUTING.md` for the full routing
protocol.

---

## Polaris Skill Bootloader

**Before proceeding, you must obtain a skill packet from the Polaris runtime.**

Run the following command:

```
polaris skill packet analyze
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

## Canonical issue template

All implementation issues (IMPLEMENT parents and children) must use the 8-section canonical format.
See `.polaris/skills/polaris-analyze/issue-template.md` for the full template.

Key rules:
- Use `## Scope` exactly — no variants ("Implementation scope", "Expected code areas", etc.).
- If scope is unknown: write `- TBD — BLOCKED: scope missing` under `## Scope` and mark the issue Blocked in Linear.
- Both IMPLEMENT parents and child issues require a full body — no title-only stubs.
- Every child must have `## Scope` and `## Validation` or the dispatch preflight gate will halt execution.

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
