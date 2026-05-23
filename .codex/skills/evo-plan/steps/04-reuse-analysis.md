# Phase 04 — Reuse Analysis

## Objective

Identify systems that already exist and can be reused or extended before proposing new work.

---

## Scope declarations

```yaml
allowed_files:
  - target-domain files identified in phase 02
  - canonical notes selected in phase 03
  - GitNexus query/context results for target concepts
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - gitnexus-exploring
expected_evidence:
  - reuse candidates listed with source paths
  - extension points and constraints identified
  - non-reuse rationale recorded
stop_rules:
  - candidate reuse requires unrelated refactor
  - GitNexus/index evidence conflicts with direct file inspection
  - reuse would violate doctrine constraints
```
## Instructions

For each reusable system category, determine whether a system already exists, can be extended, and is wired to the target domain.

Reusable system categories:

```
- Runtime surfaces (existing app runtimes, shells, entrypoints)
- Talent systems (existing capability registrations)
- Orchestration systems (existing flow controllers, coordinators)
- Cognition systems (existing memory, reasoning, context systems)
- Adapters (existing integration bridges)
- Logging and journal systems
- Auth and subscription systems
- UI systems and screen frameworks
- Infrastructure foundations
```

For each candidate area, answer:

```
- Does a system already exist for this purpose?
- Can it be extended rather than replaced?
- Does the target domain already wire into it?
- Is there a boundary rule preventing extension?
```

---

## Linked-skill usage

May invoke `gitnexus-exploring` (see `linked-skills/gitnexus-exploring.md`) to verify whether candidate systems exist and how they are wired.

---

## Duplication warnings

Warn explicitly against:

```
- Duplicate runtimes
- Duplicate orchestration layers
- Duplicate adapters
- Duplicate cognition systems
- Duplicate logging systems
- Duplicate AI inference surfaces
```

Prioritize extension and integration over replacement. If a reuse candidate is identified, mark it as such in the output — do not propose a new system to replace it.

---

## Constraints

- Do not propose implementations in this phase.
- Reuse analysis must precede gap analysis — do not merge phases.
- If gitnexus is stale, report staleness and supplement with direct inspection.

---

## Output for this phase

```
Reuse candidates:
  [System name]: [exists / extensible / already wired / boundary rule]
  ...

Duplication risks: [list or "none"]
Extension recommendations: [list]
```

---

## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `reuse_candidates`: list of identified reuse candidates
- `linked_skills_used`: append "gitnexus-exploring" if used
- `current_phase`: 04-complete
- `completed_phases`: append 04
- `next_phase`: 05-gap-analysis
