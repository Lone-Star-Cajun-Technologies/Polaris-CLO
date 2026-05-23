---
name: evo-plan
description: Doctrine-aware implementation planning for any EVO domain. Traverses canonical EVOnotes, identifies reusable architecture, detects gaps, and generates dependency-ordered Linear cluster proposals optimized for Codex execution. Analysis and cluster proposal only — no code changes, no Linear issue creation unless explicitly instructed.
---

# evo-plan

Use this skill when the user asks to plan implementation for any EVO domain, module, or subdomain.

## Related doctrine

See `docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md` for the linked-skills/task-chain composition boundary.

## When to use

- "Plan the implementation of [EVO domain or feature]"
- "Generate a Linear cluster plan for [subdomain]"
- "What's the implementation path for [capability]?"
- "Analyze what needs to be built for [domain] without duplicating existing systems"

## Trigger

```text
Use evo-plan. Target: [domain or feature].
```

With a planning spec:

```text
Use evo-plan. Planning spec: docs/evonotes/planning-specs/[name].md
```

## How to execute

1. Read `chain.md` — it defines the phase order and traversal rules.
2. Read `.taskchain_artifacts/evo-plan/current-state.json` — it contains any resumable planning state.
3. Execute phases in the order chain.md defines. Do not skip phases.
4. After every completed phase, update `.taskchain_artifacts/evo-plan/current-state.json` with minimum necessary state.
5. Do not carry large context blobs between phases. Summarize only.
6. Stop at Phase 06 if clarifying questions require answers before proceeding.

## Hard rules

- Do not implement code changes.
- Do not create Linear issues unless explicitly instructed.
- Do not treat raw notes as canonical doctrine.
- Do not silently guess on execution-critical uncertainty.
- Do not skip or reorder phases.
- Do not inline full linked-skill content — reference and invoke only.
