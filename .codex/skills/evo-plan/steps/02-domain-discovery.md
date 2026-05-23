---
name: evo-plan-step-02-domain-discovery
description: Identify the target domain's ownership, boundaries, and relationship to shared systems.
---

# Phase 02 — Domain Discovery

## Objective

Identify the target domain's ownership, boundaries, and relationship to shared systems.

---

## Scope declarations

```yaml
allowed_files:
  - planning spec path recorded in phase 01
  - repo routing files for target domain
  - nearest INSTRUCTIONS.md under target domain
  - domain README or index files
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - none
expected_evidence:
  - target domain boundaries identified
  - candidate source paths listed
  - routing constraints captured
stop_rules:
  - target domain cannot be located
  - routing instructions conflict with planning constraints
  - discovery expands beyond requested domain
```
## Instructions

Identify and report:

```
- Target domain name
- Owning app or module (e.g. flutter_app/, src/)
- Repository location
- Related domains
- Shared runtime ownership
- Shared cognition systems
- Shared adapters
- Shared orchestration systems
- Whether the target is standalone or extends an existing runtime
- Whether it belongs to an existing architecture boundary
```

Check these locations for domain orientation:
- `docs/evonotes/doctrine/[domain]/` — canonical notes for the domain
- `docs/evonotes/00-index/` — lifecycle manifest for current state

---

## Constraints

- Do not read raw notes in this phase — canonical orientation only.
- Do not assess implementation state — that is Phase 03 and 04.
- Do not propose solutions or clusters in this phase.
- Report what you find and stop.

---

## Output for this phase

```
Target domain: [name]
Owning app/module: [path]
Related domains: [list]
Shared systems: [list]
Architecture boundary: [standalone / extends existing]
Domain state: [brief summary from lifecycle manifest]
```

---

## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `target_domain`: confirmed domain name
- `current_phase`: 02-complete
- `completed_phases`: append 02
- `next_phase`: 03-canonical-note-traversal
- `notes`: any architecture boundary observations
