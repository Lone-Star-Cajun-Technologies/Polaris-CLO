# Phase 08 — Output Package

## Objective

Assemble the final deterministic planning output in the required order.

---

## Assembly order

Produce the following sections in this exact order:

```
1. Planning spec applied (if any)
2. Domain discovery summary
3. Canonical note traversal summary
4. Reuse analysis
5. Gap analysis (by category)
6. Clarifying questions (resolved — include resolutions, not open questions)
7. Cluster proposals (in dependency order)
8. Dependency map
9. Deferred work (intentionally excluded)
10. Follow-up issues recommended (if any)
```

Do not reorder sections. Do not omit sections (use "none" or "not applicable" for empty sections).

---

## Scope declarations

```yaml
allowed_files:
  - planning artifacts from phases 01-07
  - .taskchain_artifacts/evo-plan/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - linear-cluster-planning
expected_evidence:
  - final plan package includes scope, child issues, validation, risks, and open questions
  - Linear creation only performed when explicitly instructed
stop_rules:
  - output would duplicate existing project docs unnecessarily
  - required approval for Linear creation is missing
  - plan has unresolved blocking conflict
```
## Output requirements

- Audit-friendly and skimmable
- Deterministic — same inputs produce the same structure
- Copy-paste ready for Linear issue creation
- Avoid dense symbol-heavy formatting
- Avoid pseudocode unless explicitly requested
- TTS-friendly where possible

---

## Dependency map format

```
## Dependency map

[Cluster A] → [Cluster B] (Cluster A must be Done before Cluster B begins)
[Child A.1] → [Child A.2] (A.1 must be Done before A.2 begins)
...
```

If no inter-cluster dependencies exist, state "No cross-cluster dependencies."

---

## Deferred work format

```
## Deferred work

- [Item]: [reason for deferral] → recommended follow-up cluster: [name]
```

---

## Linear issue creation

If the user has explicitly instructed issue creation:
- Read `linked-skills/linear-cluster-planning.md` before proceeding
- Create issues in execution order only
- Follow the creation order rules in that descriptor

If the user has NOT explicitly instructed issue creation:
- Do not create Linear issues
- Include a note: "To create Linear issues, explicitly instruct evo-plan to do so."

---

## Constraints

- Do not add new analysis or proposals in this phase — assemble only from prior phase outputs.
- Do not expand scope in the output package.
- Output must be deterministic — resume from `.taskchain_artifacts/evo-plan/current-state.json` and phase outputs.

---

## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `status`: complete
- `linked_skills_used`: append "linear-cluster-planning" if used
- `current_phase`: 08-complete
- `completed_phases`: append 08
- `next_phase`: none
- `notes`: any final observations
