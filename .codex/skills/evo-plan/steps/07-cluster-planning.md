# Phase 07 — Cluster Planning

## Objective

Generate dependency-ordered Linear cluster proposals based on the gap analysis and reuse findings from prior phases.

---

## Cluster size governance

| Boundary | Soft cap |
|---|---|
| Children per parent cluster | 6 |
| Sub-children per child | 3 |

These are soft caps, not hard limits. If work exceeds a cap:
- Split into multiple parent clusters
- Defer non-critical work into follow-up clusters
- Explain why the cap was exceeded
- Preserve clear execution boundaries between clusters

The goal: avoid oversized clusters that cause Codex to lose context, burn excessive tokens, drift scope, or generate unstable execution behavior.

---

## Execution ordering rules

```
- Blockers first — a blocked child must never come before its blocker
- Number children so evo-run can execute them in ascending numeric order
- No forward dependencies — a child must not depend on a later-numbered child
- Dependency order must match numbering
- Parent clusters represent one execution boundary, one branch, one PR
```

---

## When to split into multiple parent clusters

Split if the work would realistically require:
- Multiple branches
- Multiple PRs
- Multiple isolated execution tracks

Each parent cluster = one branch, one PR, one review boundary.

---

## Cluster proposal format

For each proposed parent cluster:

```
## Cluster: [Name]

**Purpose**: One sentence describing what this cluster delivers.
**Boundary rationale**: Why this work is a separate execution boundary.
**Cluster size**: [N children] — within / exceeds soft cap.
**Soft cap exceeded**: [Yes/No] — if Yes, explain why.
**Deferred work**: What was intentionally moved to a follow-up cluster.
**Runtime ownership**: Which app or module owns this cluster's changes.
**Architecture references**: Canonical notes that define this work.

### Proposed children (in execution order):

[N] [Child title]
- Objective: One sentence.
- Scope: Specific files, symbols, or systems.
- Dependencies: [prior child ID] must be Done first. (Omit if none.)
- Blocker risk: [Low / Medium / High] — reason.
```

---

## Constraints

- Do not include implementation work that belongs in a follow-up cluster.
- Do not create clusters for doctrine gaps without explicit user instruction.
- Cluster proposals must be based on findings from Phases 03–06 only.
- Do not expand scope beyond the target domain without noting it explicitly.

---

## Output for this phase

Produce cluster proposals in dependency order. Include a deferred work list at the end.

---

## Scope declarations

```yaml
allowed_files:
  - planning artifacts from phases 01-06
  - Linear project/team metadata needed for draft cluster shape
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/EVOnotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - none
expected_evidence:
  - parent cluster and child issue plan drafted
  - dependencies ordered
  - acceptance criteria and validation plans included
stop_rules:
  - child split exceeds requested scope
  - dependency order cannot be made explicit
  - cluster would require unapproved external action
```
## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `cluster_count`: number of parent clusters proposed
- `current_phase`: 07-complete
- `completed_phases`: append 07
- `next_phase`: 08-output-package
- `notes`: any significant scope decisions or deferred work rationale
