---
name: polaris-run-step-03-execute-child
description: Implement the active child per its Linear issue scope and done criteria.
---

# Step 03 — Execute child

## Purpose

Implement the active child issue completely before advancing.

## Scope declarations

```yaml
allowed_files:
  - .polaris/runs/current-state.json
  - any source file within the child's scope
expected_evidence:
  - Linear issue fetched and scope confirmed
  - implementation complete per done criteria
  - tests pass (if applicable)
stop_rules:
  - child scope is ambiguous or contradicts a prior child
  - implementation would require modifying a different child's scope
  - a blocker is discovered that cannot be resolved within this session
```

## Actions

1. Fetch the active child's Linear issue to read its full scope and done criteria.
2. Implement the child. Allowed changes: source code (`src/`), tests, config files within scope.
3. Run tests and lint to confirm the implementation is valid.
4. Do not commit yet — commit happens in step 04.

### Blocker protocol

If the child cannot proceed:

```
polaris loop abort "<reason>"
```

Report the blocker and the condition needed to unblock. Halt. Do not skip to a later child.

## Artifact update

No artifact update required at this step. Update happens after commit in step 04.

## Next step

04-commit-and-update-linear
