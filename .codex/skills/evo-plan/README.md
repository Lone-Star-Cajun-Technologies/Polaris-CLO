---
name: evo-plan
description: Human-facing documentation for the evo-plan skill package.
---

# evo-plan

Doctrine-aware implementation planning for any EVO domain.

---

## Purpose

evo-plan traverses canonical EVOnotes doctrine, identifies reusable architecture, detects implementation and doctrine gaps, and generates dependency-ordered Linear cluster proposals optimized for Codex execution efficiency.

It is analysis and planning output only. It produces no code changes and creates no Linear issues unless explicitly instructed.

---

## Planning Philosophy

Planning in the EVO system is doctrine-first. Before proposing any new work, evo-plan:

1. Reads the canonical record to understand what is already defined and implemented.
2. Identifies what can be reused, extended, or integrated rather than rebuilt.
3. Categorizes gaps by type — doctrine gaps are not automatically implementation issues.
4. Asks clarifying questions before generating cluster proposals when confidence is low on execution-critical decisions.
5. Produces dependency-ordered proposals where execution order matches issue numbering.

The goal is determinism: the same inputs should produce the same planning structure across sessions.

---

## Traversal Model

Canonical notes are read in fixed trust-priority order:

```text
1. docs/evonotes/doctrine/[domain]/   ← canonical, highest trust
2. docs/evonotes/doctrine/            ← cross-domain canonical notes
3. docs/evonotes/planning-specs/      ← planning constraints
4. docs/evonotes/implemented/         ← reference only
5. docs/evonotes/needs-review/        ← lower trust, flag uncertainty
6. docs/raw/                          ← historical context and gap discovery only
```

Raw notes (`docs/raw/`) may only be used for historical context, gap discovery, and migration analysis. They are never treated as canonical truth.

Parallel subagents read directories simultaneously. Summaries are merged in the fixed trust order above. Raw content is never carried into the main context.

---

## Artifact Model

Planning state is persisted in `.taskchain_artifacts/evo-plan/current-state.json` (authoritative live state) and `.taskchain_artifacts/evo-plan/runs/*.jsonl` (append-only telemetry). `artifacts/current-run.md` is deprecated.

The snapshot acts as:
- Resumable planning state across context windows
- Phase checkpoint record
- Lightweight execution memory

After every completed phase, `current-state.json` is updated with the minimum necessary state. Full content dumps are forbidden.

If a planning session is interrupted, execution can resume from the last completed phase recorded in `current-state.json`.

---

## Linked-Skill Orchestration

evo-plan coordinates external skills rather than absorbing them. Each skill evo-plan may invoke has a descriptor in `linked-skills/` that defines:

- Source location of the original skill
- Allowed phases for invocation
- Purpose within evo-plan
- Forbidden scope

This keeps evo-plan from growing into a monolithic prompt that inlines multiple skill workflows. Each linked skill remains independent; evo-plan routes to it when appropriate.

Current linked skills:
- `linked-skills/gitnexus-exploring.md` — targeted symbol and runtime wiring inspection
- `linked-skills/docs-ingest.md` — raw file ingestion before manual promotion
- `linked-skills/linear-cluster-planning.md` — Linear issue creation when explicitly instructed

---

## Deterministic Planning Goals

- Same inputs → same output structure
- Phase order is fixed and enforced
- Trust order is fixed and enforced
- Cluster proposals are numbered to match execution order
- No forward dependencies in child numbering
- Blockers always precede blocked work

---

## Execution Boundaries

Each parent cluster proposal represents:
- One execution boundary
- One branch
- One PR
- One review boundary

Cluster size soft caps:
- 6 children per parent cluster
- 3 sub-children per child

Exceeding caps requires splitting into multiple parent clusters with explicit rationale.

---

## File Layout

```text
evo-plan/
  README.md                         ← this file (human-facing docs)
  SKILL.md                          ← agent-facing launcher (very small)
  chain.md                          ← operational traversal map
  artifacts/
    current-run.md                  ← resumable planning state
  linked-skills/
    gitnexus-exploring.md           ← gitnexus-exploring linkage descriptor
    docs-ingest.md                  ← docs-ingest linkage descriptor
    linear-cluster-planning.md      ← linear issue creation linkage descriptor
  steps/
    01-planning-spec-intake.md
    02-domain-discovery.md
    03-canonical-note-traversal.md
    04-reuse-analysis.md
    05-gap-analysis.md
    06-clarifying-questions.md
    07-cluster-planning.md
    08-output-package.md
```

---

## Related

- Planning specs: `docs/evonotes/planning-specs/`
- Canonical notes: `docs/evonotes/doctrine/`
- Lifecycle manifest: `docs/evonotes/00-index/_lifecycle-manifest.md`
- Execution skill: `.codex/skills/evo-run/SKILL.md`
- Issue analysis skill: `.claude/skills/evo-analyze/SKILL.md`
