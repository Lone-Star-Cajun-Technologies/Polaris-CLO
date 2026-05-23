---
name: evo-closeout
description: Close out a completed Linear issue set by verifying implemented work matches planning specs and GitNexus implementation graph, then promote planning specs to implemented. Not a summary tool — an implementation verification and documentation promotion gate.
---

# evo-closeout

Use this skill when an implementation cluster or issue set appears complete and needs formal closeout before planning specs can be promoted to implemented.

## Related doctrine

See `docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md` for the linked-skills/task-chain composition boundary.

## When to use

- Implementation cluster is Done and ready for formal closeout
- Planning spec promotion is needed after evo-run completion

## Trigger

```text
Use evo-closeout on EVOC-XXX
```

```text
Use evo-closeout on EVOC-XXX. The planning spec is docs/EVOnotes/planning-specs/my-spec.md.
```

```text
Use evo-closeout on EVOC-XXX. Force partial closeout and promote the spec with known gaps documented.
```

## How to execute

1. Read `chain.md` — it defines step order, promotion rules, GitNexus requirement, and execution reporting.
2. Read `.taskchain_artifacts/evo-closeout/current-state.json` — it contains any resumable closeout state.
3. Execute steps in the order chain.md defines. Do not skip steps.
4. After every completed step, update `.taskchain_artifacts/evo-closeout/current-state.json` before advancing.

## Hard rules

- Do not move any files before step 06 emits a closeout decision.
- Do not auto-close an in-progress cluster without explicit user confirmation.
- Do not promote a spec to implemented without meeting all promotion rules in chain.md.
- Do not perform partial promotion without explicit user instruction.
