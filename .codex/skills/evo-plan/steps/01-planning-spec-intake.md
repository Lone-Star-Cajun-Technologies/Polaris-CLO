---
name: evo-plan-step-01-planning-spec-intake
description: Load the planning spec and establish execution constraints for this planning session.
---

# Phase 01 — Planning Spec Intake

## Objective

Load the planning spec (if provided) and establish the execution constraints for this planning session.

---

## Scope declarations

```yaml
allowed_files:
  - provided planning spec path
  - .codex/skills/evo-plan/chain.md
  - .taskchain_artifacts/evo-plan/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - none
expected_evidence:
  - planning spec path or target domain recorded
  - execution constraints extracted
  - doctrine conflicts identified
stop_rules:
  - provided spec is unreadable
  - spec conflicts with canonical doctrine
  - target domain is missing and no spec was provided
```
## Instructions

If a planning spec path was provided in the invocation:

1. Load the planning spec file.
2. Extract all execution constraints it defines.
3. Identify any constraints that conflict with canonical EVO doctrine.
4. Report conflicts explicitly — do not silently resolve them.
5. Record the spec path in `.taskchain_artifacts/evo-plan/current-state.json` under `planning_spec`.

If no planning spec was provided:
- Proceed with the domain specified in the invoking prompt.
- Record the target domain in `.taskchain_artifacts/evo-plan/current-state.json` under `target_domain`.

---

## Constraints

- Treat the planning spec as execution constraints, not doctrine.
- Do not override spec constraints unless canonical doctrine clearly conflicts.
- If a conflict exists, report it and ask the user before proceeding.
- Do not carry the full planning spec text into subsequent phases — summarize constraints only.

---

## Output for this phase

```
Planning spec: [path or "none"]
Execution constraints extracted: [list]
Doctrine conflicts: [list or "none"]
```

---

## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `status`: in-progress
- `planning_spec`: path or "none"
- `target_domain`: from spec or invocation
- `current_phase`: 01-complete
- `completed_phases`: [01]
- `next_phase`: 02-domain-discovery
