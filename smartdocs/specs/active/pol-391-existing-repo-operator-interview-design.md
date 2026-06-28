---
status: active
kind: spec
source: smartdocs/raw/pol-391-existing-repo-operator-interview-design.md
source_issue: POL-391
analyze_run: polaris-analyze-agent-first-setup-ux-2026-06-25-001
title: Operator interview architecture for existing repo adoption — design
created: 2026-06-25
promoted_by: closeout-librarian
---

# POL-391 — Existing-repo operator interview architecture (design)

## Goal

Add a Foreman-led operator interview to existing-repo adoption that captures operator
context the scanner cannot infer (trust, staleness, "never touch", priority systems), stores
it **separately** from discovered evidence, and makes adoption plans cite *both* — so no
discovered doc becomes trusted doctrine by location alone, and all broad mutation is gated.

## Architecture

```
polaris adopt / polaris init --adopt
   └─ read-only evidence scan (existing)  → RepoScanInventory
        adopt-scan.ts · adoption-inventory.ts · adoption-plan.ts
   └─ resolve/assign Foreman (POL-392)
        └─ operator interview phase (new "interview" phase in adopt-command.ts)
             ├─ questions seeded from scan gaps (untrusted docs, ambiguous
             │    source roots, instruction files, canonical-folder candidates)
             └─ answers → .polaris/adoption/operator-context.json (separate file)
   └─ adoption plan cites evidence ⊕ operator answers
        └─ doc routing: raw | candidate | hold | review-required
             (location ≠ authority; default to raw/review-required)
   ──[APPROVAL GATES]──> doc movement · instruction-file changes ·
        graph-root changes · route scaffolding
```

## Evidence model (exists — reuse)

`RepoScanInventory` already carries `source_roots`, `docs_roots`, `agent_instruction_files`
(with `recommendation` preserve|migrate|thin-adapter), `smartdocs_candidates` (with
`estimated_risk`), `likely_canonical_folders`. This is the **discovered** half.

## Operator-answer model (new)

`.polaris/adoption/operator-context.json` — kept distinct from the scan inventory:

```jsonc
{
  "schema_version": "1.0",
  "answered_at": "<ISO>",
  "trusted_docs": ["docs/architecture/"],
  "stale_docs": ["docs/old/"],
  "never_touch": ["legacy/", "vendor/"],
  "priority_systems": ["billing", "auth"],
  "instruction_file_intent": { "CLAUDE.md": "preserve", "AGENTS.md": "migrate" }
}
```

## Adoption-plan schema (extend)

Each plan item gains provenance: `evidence_refs` (from inventory) and `operator_refs` (from
operator-context), plus a `routing` field ∈ {raw, candidate, hold, review-required}. A doc
is never routed above `raw`/`review-required` on discovery alone — promotion needs an
operator/approval signal.

## Files likely to change

- `src/cli/adopt-command.ts` — add `interview` phase between `scan` and `consolidate`
- `src/cli/adoption-context.ts` (new) — operator-answer model + persistence
- `src/cli/adoption-plan.ts` — add `evidence_refs`/`operator_refs`/`routing` to plan items
- `src/cli/adopt-approve.ts` — gates for doc movement / instruction-file / graph-root / route
- `src/cli/adopt-instructions.ts`, `adopt-smartdocs.ts` — honor routing + operator intent

## Command surface

Intent stays `polaris adopt` / `polaris init --adopt`. `--resume`/`--yes` honored. No new
top-level command.

## Approval gates

Distinct gates before: (a) document movement out of raw, (b) instruction-file edits, (c)
graph-root/route changes, (d) any source mutation. Each gate previews the diff and requires
explicit approval (reuse `promptApproval`).

## Validation plan

- `npm run build`
- `npx vitest run src/cli/adopt-command.test.ts src/cli/adoption-plan.test.ts`
- Fixture repo with mixed docs → assert nothing promotes above raw without operator answer +
  approval; assert operator-context.json written separately from inventory.

## Non-goals

- Do not implement the interview UI beyond the adoption flow.
- Do not mutate SmartDocs lifecycle semantics.
- Do not weaken existing approval gates.

## Risks / stop conditions

- Operator answers must never silently overwrite evidence — keep the two models separate and
  cite both.
- Non-interactive runs require a supplied operator-context file or must stop before mutation.

## Ordered implementation children

1. Operator-answer model stored separately from evidence
2. Foreman adoption interview phase in `adopt-command.ts`
3. Adoption plan cites evidence + operator answers with doc routing
4. Approval gates before doc movement / instruction / graph-root / route changes

Depends on POL-392 (Foreman handoff).
