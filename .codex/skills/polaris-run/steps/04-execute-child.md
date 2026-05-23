---
name: polaris-run-step-04-execute-child
description: Implement the current child issue with the smallest scoped change possible.
---

# Step 04 — Execute child

## Purpose

Execute only the selected child worker scope. In interactive-agent mode this step belongs inside the worker session dispatched by the execution adapter; the parent/orchestrator must not perform child implementation inline.

## Scope declarations

```yaml
allowed_files:
  - files explicitly named by selected Linear child
  - nearest POLARIS.md or INSTRUCTIONS.md for each edited path
  - source files required by child acceptance criteria
  - .taskchain_artifacts/polaris-run/current-state.json
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .codex/skills/polaris-run/chain.md
allowed_skills:
  - gitnexus
expected_evidence:
  - child acceptance criteria implemented
  - touched paths match child scope
  - no files outside child scope modified
stop_rules:
  - requested edit conflicts with existing architecture or doctrine
  - implementation requires cross-cluster work
  - same approach failed twice — stop and ask
  - no edit made within 10 minutes — stop and ask
```

## Actions

1. Confirm this is a worker execution context for the selected child. If this is a parent/orchestrator context with another open child to dispatch, return to step 07 and use the execution adapter instead of implementing inline.
2. Re-fetch the current child issue from Linear to confirm latest state, requirements, and any new blocking relationships.
3. Identify the files relevant to this child. Inspect only those files.
4. Use GitNexus for targeted file or symbol lookup only — not broad repo analysis.
5. Make the smallest scoped change that satisfies the child's acceptance criteria.
6. Do not touch files outside the child's scope.
7. Do not perform unrelated cleanup.
8. If a discovery falls outside the child's scope: note it as a follow-up — do not silently expand scope.

## Blocker protocol

If the child cannot proceed:

```
polaris loop abort "<reason>"
```

Halt. Report the unblock condition. Do not skip to later children.

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `current_step_id: 04-execute-child`
- `status: executing`
- `updated_at: <timestamp>`

## Next step

05-validate-child
