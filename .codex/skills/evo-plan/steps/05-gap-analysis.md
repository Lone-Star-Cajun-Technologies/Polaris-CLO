# Phase 05 — Gap Analysis

## Objective

Categorize what is missing. Separate doctrine gaps from implementation gaps. Do not conflate them.

---

## Scope declarations

```yaml
allowed_files:
  - planning spec path
  - phase 02 domain map
  - phase 03 canonical notes
  - phase 04 reuse candidates
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - gitnexus-exploring
expected_evidence:
  - implementation gaps listed
  - risks and dependencies mapped
  - follow-up issue boundaries proposed
stop_rules:
  - gap cannot be tied to source evidence
  - gap requires cross-cluster change
  - risk cannot be bounded
```
## Instructions

Evaluate what the target domain needs but does not yet have, across these categories:

| Gap Category | Description |
|---|---|
| **Doctrine gap** | No canonical note defines this behavior or boundary |
| **Implementation gap** | Doctrine exists but code does not |
| **Runtime wiring gap** | System exists but is not connected to the target domain |
| **UI gap** | Screens or surfaces are missing |
| **Orchestration gap** | Flow coordination is undefined or unimplemented |
| **Test gap** | Acceptance criteria exist but tests do not |
| **Governance gap** | Ownership, boundary, or review process is undefined |
| **Adapter gap** | Integration bridge is missing |
| **Cognition gap** | Memory, reasoning, or context system is not wired |

---

## Doctrine gap rule

Doctrine gaps must NOT automatically become implementation issues.

If doctrine is missing:
- Flag it separately
- Record it in the clarifying questions for Phase 06
- Ask the user whether it should become governance work or implementation work

Do not propose an implementation issue for a doctrine gap without explicit user confirmation.

---

## Linked-skill usage

May invoke `gitnexus-exploring` (see `linked-skills/gitnexus-exploring.md`) to confirm whether specific gaps are real (system truly absent) vs. index staleness.

---

## Constraints

- Report one section per gap category.
- Omit empty categories.
- Do not merge doctrine gaps with implementation gaps in the same list item.
- Do not propose cluster solutions in this phase.

---

## Output for this phase

```
Gap analysis:

Doctrine gaps:
  - [description] — requires user decision before implementation

Implementation gaps:
  - [description]

Runtime wiring gaps:
  - [description]

[other non-empty categories...]

Doctrine gaps requiring user decision: [list]
```

**Summarization rule**: one line per gap item. Do not include raw file content, full doctrine excerpts, or verbose tool output. If a category has more than 5 items, list the first 3 and summarize: "N additional items — see notes."

---

## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `identified_gaps`: summary of gaps by category
- `linked_skills_used`: append "gitnexus-exploring" if used
- `current_phase`: 05-complete
- `completed_phases`: append 05
- `next_phase`: 06-clarifying-questions
