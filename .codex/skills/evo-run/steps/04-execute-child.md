---
name: evo-run-step-04-execute-child
description: Implement the current child issue with the smallest scoped change, using targeted GitNexus lookup only.
---

# Step 04 — Execute child

## Purpose

Implement the current child issue with the smallest scoped change possible.

## Scope declarations

```yaml
allowed_files:
  - files explicitly named by selected Linear child
  - nearest INSTRUCTIONS.md for each edited path
  - doctrine or source files required by selected child acceptance criteria
  - .taskchain_artifacts/evo-run/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills:
  - gitnexus
  - ce-debug
  - ce-code-review
  - ce-resolve-pr-feedback
  - ce-simplify-code
  - ce-agent-native-architecture
expected_evidence:
  - selected child acceptance criteria implemented
  - touched paths match child scope
  - impact/routing evidence captured when significant symbols change
stop_rules:
  - requested edit conflicts with routing or doctrine
  - required impact analysis reports HIGH or CRITICAL risk without user acknowledgement
  - implementation requires cross-cluster work
```
## Actions

1. Re-fetch the current child issue from Linear (using the ID recorded in step 03) to ensure you have the latest state, requirements, and any new blocking relationships.
2. Identify the files relevant to this child. Inspect only those files.
3. Use GitNexus for targeted file or symbol lookup only — not broad repo analysis or report generation.
4. Make the smallest scoped change that satisfies the child's acceptance criteria.
5. Do not touch files outside the child's scope.
6. Do not perform unrelated cleanup.
7. Do not re-audit completed children.
8. If the same fix approach fails twice, stop and ask the user before retrying.
9. If no edit has happened within 10 minutes of execution work, stop and ask whether to continue, narrow scope, or switch approach.

## Scope boundary

Every changed line must trace directly to the current child's requirements. If a discovery falls outside the child's scope, note it as a follow-up issue — do not silently expand scope.

## Artifact update

After completing execution (before validation), update `.taskchain_artifacts/evo-run/current-state.json`:
- `current_step_id: 04-execute-child`
- `status: executing`
- `updated_at: <timestamp>`

## Next step

05-validate-child
