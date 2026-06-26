---
kind: spec
status: active
source: smartdocs/raw/pol-390-new-repo-setup-interview-design.md
source_issue: POL-390
analyze_run: polaris-analyze-agent-first-setup-ux-2026-06-25-001
title: Polaris setup interview architecture for new repo init — design
created: 2026-06-25
promoted_by: closeout-librarian
---

# POL-390 — New-repo setup interview architecture (design)

## Goal

Add a Foreman-led setup interview to `polaris init` for new/empty repositories that captures
operator intent, then drives approval-gated generation of `GENESIS.md`, `POLARIS_RULES.md`,
`polaris.config.json`, initial SmartDocs intake, and route surfaces — producing
implementation-ready output without blindly scaffolding files.

## Architecture

```
polaris init  (new/empty repo path in init.ts)
   └─ resolve/assign Foreman (POL-392)
        └─ setup interview runner  (src/cli/setup-interview/)
             ├─ question bank (intent: project purpose, source roots,
             │    languages, canonical doc folders, "never touch" paths,
             │    provider/role prefs)
             ├─ answers persisted → .polaris/setup/interview.json  (resumable)
             └─ interview result schema → consumed by generators
        └─ generation plan (preview)  ──[APPROVAL GATE]──> generators:
             GENESIS.md · POLARIS_RULES.md · polaris.config.json ·
             route surfaces · initial smartdocs/raw intake
        └─ post-setup validation + checkpoint report
```

Reuse: `init-detect.ts:detectRepoState` to confirm the "new/empty" path;
`agent-setup.ts:runAgentSetup` for provider/role capture; `adopt-approve.ts:promptApproval`
for the gate; existing generators referenced by `init.ts` (`scaffoldRootSurfaces`,
`generatePolarisRules`, `migrateSmartDocs`, `runMapIndex`).

## Data model / schemas

`.polaris/setup/interview.json`:

```jsonc
{
  "schema_version": "1.0",
  "mode": "init",
  "status": "in-progress | answered | approved",
  "started_at": "<ISO>",
  "answers": {
    "project_purpose": "string",
    "source_roots": ["src/"],
    "languages": ["typescript"],
    "canonical_doc_folders": ["docs/"],
    "never_touch": ["vendor/", "generated/"],
    "providers_by_role": { "foreman": "codex", "worker": "devin" }
  },
  "generation_plan": { "targets": ["GENESIS.md", "polaris.config.json", "..."] },
  "approved_at": null
}
```

Storage is resumable: `polaris init --resume` (flag already exists) re-reads
`interview.json` and continues at the next unanswered question or the approval gate.

## Files likely to change

- `src/cli/init.ts` — wire interview into the new-repo branch of `createInitCommand`
- `src/cli/setup-interview/` (new) — runner, question bank, schema, persistence
- `src/cli/agent-setup.ts` — reuse for provider/role answers
- `src/cli/adopt-approve.ts` — reuse approval gate (or extend for init mode)
- `polaris.config.json` writers (existing) — consume interview answers

## Command surface

No new top-level command. Intent stays `polaris init`; `--resume` resumes; `--dry-run`
previews the generation plan without writing. Low-level commands unchanged.

## Approval gates

Single mandatory gate before any file generation: operator previews the full generation
plan (genesis + config + rules + routes + intake) and must approve. `--yes` may pre-approve
only when explicitly passed.

## Validation plan

- `npm run build`
- `npx vitest run src/cli/setup-interview src/cli/init.test.ts`
- Fresh-repo smoke: run `polaris init` in an empty temp dir → interview → approve → assert
  generated files + a passing checkpoint report.

## Non-goals

- Do not implement slash commands (POL-393).
- Do not change existing adoption behavior (POL-391).
- Do not auto-promote any generated doc to canon.

## Risks / stop conditions

- Interview must degrade gracefully when run non-interactively (CI): require `--yes` + a
  pre-supplied answers file, else stop.
- Do not duplicate `agent-setup.ts`; extend it.

## Ordered implementation children

1. Setup-interview schema + resumable storage
2. Foreman-led interview runner wired into `polaris init`
3. Approval-gated generation from interview output
4. Post-setup validation + checkpoint report

Depends on POL-392 (Foreman handoff) for the runner's Foreman binding.
