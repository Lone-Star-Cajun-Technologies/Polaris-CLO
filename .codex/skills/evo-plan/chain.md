---
name: evo-plan-chain
description: Route map for evo-plan — defines phase order, linked-skill boundaries, artifact update requirements, stop conditions, output assembly, and execution reporting.
---

# evo-plan chain

Operational traversal map. Defines phase order, linked-skill boundaries, artifact update requirements, stop conditions, and output assembly.

---

## Phase Order

Execute in strict ascending order. Do not skip, reorder, or merge phases.

```text
01 → planning-spec-intake
02 → domain-discovery
03 → canonical-note-traversal
04 → reuse-analysis
05 → gap-analysis
06 → clarifying-questions          ← STOP HERE if questions require answers
07 → cluster-planning
08 → output-package
```

---

## Phase Execution Rules

**Before each phase:**
- Read the relevant step file: `steps/0N-[name].md`
- Load only context needed for that phase
- Check `.taskchain_artifacts/evo-plan/current-state.json` to determine if phase is already complete

**After each phase:**
- Update `.taskchain_artifacts/evo-plan/current-state.json` with phase state (minimum necessary fields only)
- Set `current_phase` to mark current progress, update `completed_phases` list, and set `next_phase`
- Do not carry full phase output into next phase — summarize only

---

## Linked-Skill Invocation Boundaries

| Skill | Allowed phases | Descriptor |
|---|---|---|
| gitnexus-exploring | 03, 04, 05 | `linked-skills/gitnexus-exploring.md` |
| docs-ingest | Pre-01 (if raw files detected) | `linked-skills/docs-ingest.md` |
| linear-cluster-planning | 08 (only if explicitly instructed) | `linked-skills/linear-cluster-planning.md` |

Before invoking any linked skill, read its descriptor to confirm the phase is allowed and scope is within bounds.

---

## Stop Conditions

**Phase 06 (clarifying-questions):**
Stop and wait for user response if:
- Confidence is LOW on any execution-critical decision
- Execution ordering is ambiguous
- Ownership boundaries are unclear
- Doctrine gap requires a governance vs. implementation decision

Do not proceed to Phase 07 until all execution-critical questions are answered.

**Any phase:**
Stop immediately if:
- A canonical doctrine conflict is discovered that cannot be resolved without user input
- The target domain is outside the scope of the planning spec
- A HIGH or CRITICAL risk symbol is identified by gitnexus-exploring

---

## Artifact Authority

`.taskchain_artifacts/evo-plan/current-state.json` is the sole authoritative live state surface for evo-plan. Agents resume from this snapshot — not from `current-run.md` (deprecated) or by replaying telemetry.

`run-report.md` (`.taskchain_artifacts/evo-plan/run-report.md`) is a generated closeout artifact written once at run completion or handoff. It is never updated per-step.

`current-run.md` is deprecated. Existing files are retained as historical records only. Do not create or update `current-run.md` in new runs.

## Run ID Format

Format: `evo-plan-<slug>-<date>-<sequence>` (e.g., `evo-plan-calendar-mobile-2026-05-22-001`).
Tracker IDs must NOT appear in the slug.

## Artifact Update Requirements

After each phase, update `.taskchain_artifacts/evo-plan/current-state.json`:

| Field | Updated by phase |
|---|---|
| `status` | Every phase |
| `current_phase` | Every phase |
| `completed_phases` | Every phase |
| `next_phase` | Every phase |
| `updated_at` | Every phase |
| `planning_spec` | 01 |
| `target_domain` | 01 |
| `canonical_sources_read` | 03 |
| `linked_skills_used` | 03, 04, 05 |
| `reuse_candidates` | 04 |
| `clarifying_questions` | 06 |
| `cluster_count` | 07 |
| `identified_gaps` | 05 |
| `notes` | Any phase (as needed) |

---

## Machine Snapshot

The machine snapshot is the authoritative live state for evo-plan.

- **Path**: `.taskchain_artifacts/evo-plan/current-state.json`
- **Schema reference**: `.evo/run-state/current-state-schema.md`
- **Update requirement**: update after every completed phase
- **Purpose**: enables fast agent resume without replaying markdown history or JSONL

---

## Telemetry

Telemetry is append-only operational history for audit, replay, and debugging.

- **Path pattern**: `.taskchain_artifacts/evo-plan/runs/[run-id].jsonl`
- **Event catalog reference**: `.evo/run-state/event-catalog.md`
- **Append-only rule**: never delete or modify existing lines — only append new events
- **Purpose**: records what actually happened during a run; not used as the primary resume source
- **Legacy telemetry**: pre-migration files in `.codex/skills/evo-plan/artifacts/runs/` are historical records
- **Telemetry compliance**: new events must conform to `.evo/run-state/event-catalog.md` — no other field names are valid
- **Required fields**: `event`, `run_id`, `timestamp`, `step_id` (all events)
- **Deprecated field**: `ts` — do not use in new runs; pre-governance alias for `timestamp`
- **Non-conforming fields**: `event_type` and `summary` are not catalog fields; do not emit them in new runs

## Validation Summarization

Analysis output written to `.taskchain_artifacts/evo-plan/current-state.json` must be concise summaries — never raw file excerpts or full doctrine dumps.

- **Permitted**: pass/fail assessments; categorized gap counts; one-line-per-item summaries; first conflict only
- **Prohibited**: raw file content; full doctrine excerpts; verbose tool output
- **Maximum**: 5–10 lines per category recorded in the artifact

This rule applies to all phases that record findings, gaps, or analysis results.

---

## Output Assembly Order (Phase 08)

Assemble final output in this fixed order:

```text
1. Planning spec applied (if any)
2. Domain discovery summary
3. Canonical note traversal summary
4. Reuse analysis
5. Gap analysis (by category)
6. Clarifying questions (if any — resolved before this point)
7. Cluster proposals (in dependency order)
8. Dependency map
9. Deferred work (intentionally excluded)
10. Follow-up issues recommended (if any)
```

Output requirements:
- Audit-friendly and skimmable
- Deterministic — same inputs produce the same structure
- Copy-paste ready for Linear issue creation
- Avoid dense symbol-heavy formatting
- Avoid pseudocode unless explicitly requested

---

## Execution reporting

Invoke caveman-lite at session start. It governs all user-facing responses for the duration of the run.

After each completed phase, emit a checkpoint:

```text
**[phase-name]** done | blocked | needs-input
Changed: <artifact fields updated / cluster proposals> or none
Validated: <checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full regardless of caveman mode:
- Cluster proposals and child issue bodies (generated planning artifacts)
- Clarifying questions (phase 06)
- Doctrine conflict escalations
- HIGH or CRITICAL risk findings from GitNexus
- Final output package (phase 08)
