# Phase 06 — Clarifying Questions

## Objective

Identify execution-critical uncertainties and stop for user input before generating cluster proposals.

---

## Scope declarations

```yaml
allowed_files:
  - planning artifacts from phases 01-05
  - .taskchain_artifacts/evo-plan/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - none
expected_evidence:
  - only blocker questions emitted
  - non-blocking assumptions recorded
  - decision to continue or stop documented
stop_rules:
  - missing answer blocks safe planning
  - question would decide product scope not present in sources
  - assumption would be high risk
```
## Instructions

Assess confidence on each of the following decision areas:

```
- Execution order of proposed work
- Ownership boundaries (which app, which runtime, which team)
- Project assignment in Linear
- Whether work belongs in the current cluster or a follow-up
- Whether a dependency already exists in the codebase
- Whether missing doctrine should become implementation or governance work
- Whether a system should be reused, extended, or replaced
```

For each item where confidence is LOW on an execution-critical decision:

1. State the question clearly.
2. State what you know and what is uncertain.
3. State what the answer would change about the cluster proposals.
4. **Stop and wait for the user to answer.**

---

## Stop condition

If any clarifying question is execution-critical, stop at this phase.

Do not proceed to Phase 07 until:
- All execution-critical questions are answered, or
- The user explicitly instructs to proceed with stated assumptions

---

## Silent guessing rule

Do not silently guess on execution-critical items. Name the uncertainty, ask, and wait.

If the item is non-critical and a reasonable assumption exists, state the assumption explicitly and proceed — do not stop for non-critical items.

---

## Constraints

- This phase must occur before cluster planning.
- Do not propose clusters or solutions within this phase.
- Do not carry resolved questions into Phase 07 — record resolutions in `.taskchain_artifacts/evo-plan/current-state.json` and proceed.

---

## Output for this phase

If questions exist:

```
Clarifying questions:

[1] [Question text]
  Context: [what is known]
  Impact: [what this changes about the plan]

[2] ...

--- STOP — awaiting user response ---
```

If no questions:

```
Clarifying questions: none — proceeding to cluster planning.
```

---

## Artifact update

After completing this phase (or after receiving user responses if stopped):
- `clarifying_questions`: list of questions and resolutions
- `current_phase`: 06-complete
- `completed_phases`: append 06
- `next_phase`: 07-cluster-planning
- `notes`: any assumptions made for non-critical items
