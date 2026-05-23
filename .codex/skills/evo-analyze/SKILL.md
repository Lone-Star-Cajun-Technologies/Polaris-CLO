---
name: evo-analyze
description: Audit one Linear issue against the actual repo using GitNexus and targeted inspection, then produce an ordered Codex-runnable Linear child issue plan. Analysis and issue creation only — no code changes.
---

# evo-analyze

Use this skill when the user asks to analyze or break down a Linear issue before execution.

## Related doctrine

See `docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md` for the linked-skills/task-chain composition boundary.

## When to use

- "Analyze EVOC-XXX before running it"
- "Break down EVOC-XXX into child issues"
- "Is EVOC-XXX ready to execute?"

## Trigger

```text
Use evo-analyze on EVOC-XXX
```

Expected result: Claude audits the repo and Linear issue, creates ordered child issues, and tells the user:

```text
Use the evo-run skill. Run EVOC-XXX.
```

## How to execute

1. Read `chain.md` — it defines the step order and traversal rules.
2. Read `.taskchain_artifacts/evo-analyze/current-state.json` — it contains any resumable state.
3. Execute steps in the order chain.md defines. Do not skip steps.
4. After every completed step, update `.taskchain_artifacts/evo-analyze/current-state.json` before advancing.

## Hard rules

- Analysis and issue creation only.
- Do not implement code changes.
- Do not create branches.
- Do not commit files.
- Do not create PRs.
