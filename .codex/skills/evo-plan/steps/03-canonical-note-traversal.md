---
name: evo-plan-step-03-canonical-note-traversal
description: Read canonical EVOnotes in trust-priority order and build a doctrine summary for the target domain.
---

# Phase 03 — Canonical Note Traversal

## Objective

Read canonical EVOnotes in trust-priority order and build a doctrine summary for the target domain.

---

## Scope declarations

```yaml
allowed_files:
  - docs/evonotes/**/*.md selected by target domain
  - docs/evonotes/**/INSTRUCTIONS.md
  - planning spec path recorded in phase 01
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-plan/chain.md
  - docs/evonotes/**/*.md when selected by phase-specific traversal
allowed_skills:
  - gitnexus-exploring
expected_evidence:
  - canonical notes read are listed
  - doctrine constraints summarized
  - stale references flagged
stop_rules:
  - canonical note says not to update it
  - stale doctrine conflict is unresolved
  - no canonical source supports requested direction
```
## Instructions

Dispatch parallel subagents to read each directory simultaneously. Do not traverse sequentially. Each subagent reads one directory and returns a summary. Raw content must not be carried into the main context.

Merge summaries in this fixed trust-priority order:

```
1. docs/evonotes/doctrine/[domain]/   ← canonical, highest trust
2. docs/evonotes/doctrine/            ← cross-domain canonical notes
3. docs/evonotes/planning-specs/      ← planning constraints
4. docs/evonotes/implemented/         ← reference only
5. docs/evonotes/needs-review/        ← lower trust — flag uncertainty
6. docs/raw/                          ← historical context and gap discovery only
```

---

## Raw note rules

Raw notes (`docs/raw/`) may only be used for:
- Historical context
- Discovery of missing doctrine
- Migration analysis
- Identifying doctrine gaps

Do not treat raw notes as canonical truth. Flag when a finding comes from a raw note rather than a canonical note.

---

## Linked-skill usage

May invoke `gitnexus-exploring` (see `linked-skills/gitnexus-exploring.md`) for:
- Targeted inspection of how domain systems are wired in the codebase
- Symbol lookup for specific concepts found in canonical notes

Do not use gitnexus for broad scanning. Summarize findings — do not carry symbol dumps into Phase 04.

---

## Constraints

- Merge summaries in the fixed trust order above — do not reorder.
- Flag findings from `needs-review/` or `docs/raw/` with their trust level.
- Do not reproduce raw note content in the traversal summary.
- Do not carry broad context into Phase 04 — summarize only.

---

## Output for this phase

```
Traversal summary:
  1. docs/evonotes/doctrine/[domain]/: [summary]
  2. docs/evonotes/doctrine/: [summary]
  3. docs/evonotes/planning-specs/: [summary or "not applicable"]
  4. docs/evonotes/implemented/: [summary]
  5. docs/evonotes/needs-review/: [summary — flagged as lower trust]
  6. docs/raw/: [summary — flagged as historical context only]

Key doctrine points: [list]
Flagged uncertainties: [list or "none"]
```

---

## Artifact update

After completing this phase, update `.taskchain_artifacts/evo-plan/current-state.json`:
- `canonical_sources_read`: list of directories read
- `linked_skills_used`: append "gitnexus-exploring" if used
- `current_phase`: 03-complete
- `completed_phases`: append 03
- `next_phase`: 04-reuse-analysis
- `notes`: key doctrine points and flagged uncertainties
