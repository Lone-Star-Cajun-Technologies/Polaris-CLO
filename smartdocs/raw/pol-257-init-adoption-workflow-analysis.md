---
id: pol-257-init-adoption-workflow-analysis
kind: analysis
status: raw
owner: analyst
issue: POL-257
created: 2026-05-31
implements: []
related:
  - POL-256
  - POL-233
  - POL-241
  - POL-240
  - POL-242
---

# POL-257: Polaris Init and Repository Adoption Workflow Analysis

## Summary

This document defines the recommended init and adoption workflows for Polaris, covering new repository initialization and existing repository adoption. It produces the order-of-operations decision, schemas, handling rules, and ordered implementation children.

---

## 1. Repository State Detection

Before any init or adoption logic runs, Polaris must classify the target directory into one of five states. The detection is strictly read-only.

| State | Detection Criteria |
|---|---|
| `empty` | Directory is empty or contains only `.git/` |
| `new` | Has a `package.json` or basic source structure but no existing docs, agent files, or Polaris config |
| `partial` | Has `polaris.config.json` but no `.polaris/map/file-routes.json` |
| `existing` | Has source roots, docs, and/or agent instruction files but no `polaris.config.json` |
| `polaris-enabled` | Has `polaris.config.json` AND `.polaris/map/file-routes.json` |

Detection order: check `polaris-enabled` first, then `partial`, then scan for `existing` indicators, then `new`, then `empty`. A repo triggering no indicators is treated as `empty`.

The `existing` state is the riskiest — it requires the full adoption flow with user approval before mutation.

---

## 2. New Repository Init Flow

For `empty` and `new` states. Low risk; no user approval required before scaffold creation.

```
Step 1: Minimal provider config
  → Write polaris.config.json with provider locked to local-only or a single approved provider
  → No cross-agent dispatch enabled until user explicitly configures it

Step 2: Create .polaris/ skeleton
  → .polaris/map/         (empty atlas files)
  → .polaris/clusters/    (empty)
  → .polaris/runs/        (empty)
  → .polaris/bootstrap/   (empty)

Step 3: SmartDocs scaffold
  → Call existing ensureDocsScaffold()
  → Creates smartdocs/{raw,architecture,decisions,doctrine/{active,candidate,deprecated},specs/{active,implemented,superseded},audits,integrations,runtime/{generated,run-reports,summaries}}

Step 4: Root cognition files
  → Generate minimal root POLARIS.md (template, marked polaris:draft)
  → Generate minimal root SUMMARY.md (template, marked polaris:draft)

Step 5: Atlas baseline
  → Run polaris map index
  → Produces empty or sparse file-routes.json (expected; no files yet)

Step 6: Stage and report
  → Stage all generated files
  → Print adoption summary (files created, next steps)
  → Do NOT auto-commit unless --commit flag is present
```

### New Repo .gitignore additions

Append during Step 2:
```
.polaris/runs/
.polaris/bootstrap/
.polaris/clusters/
.polaris/session-type
```

These are runtime artifacts and must not be committed. The canonical `.polaris/map/` files are committed (they are the Atlas sidecar).

---

## 3. Existing Repository Adoption Flow

For `existing` state. Higher risk; user approval is mandatory before any mutation.

### Phase A: Safe Setup (no mutation)

```
Step A1: Minimal provider config (first, before anything else)
  → Write polaris.config.json with:
      execution.rotation = []                  (no rotation)
      execution.allowCrossAgentFallback = false
      execution.adapter = "terminal-cli"
      orchestration.mode = "supervised"
  → This prevents any agent dispatch during adoption, regardless of later config merges
  → Integrate with POL-256: provider roles are not assigned until adoption is complete

Step A2: Read-only repo scan
  → Produce RepoScanInventory (see §5 schema)
  → Scan: package manager, source roots, docs roots, test/build commands
  → Scan: existing agent instruction files (CLAUDE.md, AGENTS.md, .github/copilot-instructions.md, .cursorrules, .aider*, etc.)
  → Scan: generated roots, cache roots, fixture roots (for exclusion)
  → Scan: existing docs and architecture notes as SmartDocs candidates
  → Scan: likely canonical folders (folders with stable source or doc content)
  → No writes during this step
```

### Phase B: Plan and Approve

```
Step B1: Generate adoption plan
  → Produce AdoptionPlan (see §6 schema)
  → Human-readable Markdown summary at .polaris/adoption-plan.md
  → Machine-readable JSON at .polaris/adoption-plan.json
  → Plan shows: proposed SmartDocs moves, proposed cognition files, proposed instruction refactors,
    proposed .polarisignore additions, proposed Atlas routes

Step B2: User approval gate
  → Print plan to stdout
  → Pause and require explicit approval: y/N prompt
  → --yes flag bypasses prompt (for CI pipelines, with explicit acknowledgment)
  → --dry-run flag runs all subsequent steps without writing (prints what would happen)
  → If user declines, abort cleanly; polaris.config.json already written is safe to keep
```

### Phase C: Controlled Mutation (only after approval)

```
Step C1: Create .polaris/ skeleton (same as new repo Step 2)

Step C2: SmartDocs migration
  → For each SmartDocsCandidate in the plan:
      - git mv <source_path> smartdocs/raw/<filename> (preserve git history)
      - If git mv fails, fallback to copy + record in provenance
  → Record provenance in .polaris/adoption-provenance.json (old path → new path)
  → Do NOT promote to smartdocs/doctrine/active/ at this stage
  → Existing docs need human review before becoming canonical truth

Step C3: Folder cognition generation
  → For each likely_canonical_folder in inventory:
      - Skip: generated_roots, cache_roots, fixture_roots, node_modules, dist, .git, .polaris/runs, .polaris/bootstrap
      - Skip: any folder with fewer than 3 source files (too sparse for useful cognition)
      - Create POLARIS.md (template, polaris:draft) if not present
      - Create SUMMARY.md (template, polaris:draft) if not present
  → Follow POL-233 and POL-241 rules for draft promotion lifecycle

Step C4: Agent instruction file refactor
  → Apply rules from §7
  → Never silently delete existing instruction content
  → If converting to thin adapter, save original content to smartdocs/raw/migrated-instructions/<filename>

Step C5: Atlas/map generation
  → Run polaris map index
  → Validate: moved docs appear in atlas
  → Record baseline coverage in .polaris/map/index.json
  → Acceptance: any initial coverage is valid; flag outstanding needs-review.json items as adoption debt

Step C6: Stage and commit
  → Apply policy from §8
  → Print adoption summary
```

---

## 4. Order-of-Operations Rationale

The critical constraint is: **provider config must be locked before any scan or mutation that could trigger agent dispatch.**

The following ordering invariants must hold:

1. Provider config lock (A1) **before** repo scan (A2). The scan may invoke lightweight inference; if a provider were configured, it could accidentally dispatch.
2. Read-only scan (A2) **before** adoption plan (B1). Plan is derived from scan output.
3. Adoption plan (B1) **before** user approval (B2). User must see what will happen before it happens.
4. User approval (B2) **before** any mutation (C1–C6). This is the safety gate.
5. SmartDocs migration (C2) **before** cognition generation (C3). Cognition files reference canonical folder structure; moved docs change that structure.
6. Instruction file refactor (C4) **before** Atlas generation (C5). Atlas instruction file resolution walks up to find POLARIS.md; instruction refactors affect that walk.
7. Atlas generation (C5) **before** staging (C6). The atlas files are part of the adoption commit.

---

## 5. Repo Scan Inventory Schema

```typescript
interface RepoScanInventory {
  scan_date: string;                          // ISO 8601
  repo_state: "empty" | "new" | "partial" | "existing" | "polaris-enabled";
  package_manager: "npm" | "yarn" | "pnpm" | "bun" | null;
  source_roots: string[];                     // e.g. ["src/", "lib/"]
  docs_roots: string[];                       // e.g. ["docs/", "wiki/"]
  test_commands: string[];                    // e.g. ["npm test", "vitest run"]
  build_commands: string[];                   // e.g. ["npm run build", "tsc"]
  package_scripts: Record<string, string>;    // all scripts from package.json
  generated_roots: string[];                  // e.g. ["dist/", ".next/", "build/"]
  cache_roots: string[];                      // e.g. [".cache/", ".turbo/"]
  fixture_roots: string[];                    // e.g. ["fixtures/", "__fixtures__/", "test/data/"]
  agent_instruction_files: AgentInstructionFile[];
  existing_smartdocs_dirs: string[];          // already-present smartdocs/ or docs/ with structure
  architecture_notes: string[];               // detected ADRs, RFCs, design docs
  likely_canonical_folders: string[];         // stable folders suitable for cognition files
  smartdocs_candidates: SmartDocsCandidate[];
  ignore_candidates: string[];                // paths to add to .polarisignore
}

interface AgentInstructionFile {
  path: string;
  provider: "claude" | "openai" | "copilot" | "cursor" | "gemini" | "aider" | "unknown";
  size_bytes: number;
  has_polaris_delegation: boolean;            // already points at Polaris doctrine
  recommendation: "preserve" | "migrate" | "thin-adapter";
  reason: string;
}

interface SmartDocsCandidate {
  path: string;
  kind: "doc" | "spec" | "decision" | "architecture" | "integration" | "unknown";
  suggested_destination: string;              // e.g. "smartdocs/raw/filename.md"
  confidence: number;                         // 0.0–1.0
  has_frontmatter: boolean;
  estimated_risk: "low" | "medium" | "high"; // low = plain doc, high = critical instruction file
}
```

The inventory JSON is saved to `.polaris/adoption-inventory.json` (read-only artifact; not mutated after scan).

---

## 6. Adoption Plan Schema

```typescript
interface AdoptionPlan {
  plan_id: string;                            // e.g. "adoption-2026-05-31T..."
  generated_at: string;                       // ISO 8601
  repo_state: RepoScanInventory["repo_state"];
  approved: boolean;                          // set to true after user approval
  approved_at: string | null;
  dry_run: boolean;
  steps: AdoptionStep[];
  impact_summary: AdoptionImpact;
}

interface AdoptionStep {
  step_id: string;                            // e.g. "smartdocs-migrate-001"
  order: number;
  phase: "A" | "B" | "C";
  category:
    | "provider-config"
    | "scaffold"
    | "smartdocs-migrate"
    | "cognition-generate"
    | "instruction-refactor"
    | "atlas-generate"
    | "ignore-rules"
    | "stage";
  action: "create" | "move" | "modify" | "skip" | "append";
  source_path?: string;
  dest_path?: string;
  description: string;
  destructive: boolean;                       // true = moves/modifies existing file
  requires_approval: boolean;                 // true = blocked until B2
  estimated_risk: "low" | "medium" | "high";
  status: "pending" | "completed" | "skipped" | "failed";
  completed_at?: string;
  error?: string;
}

interface AdoptionImpact {
  files_to_create: number;
  files_to_move: number;
  files_to_modify: number;
  instruction_files_affected: number;
  smartdocs_candidates_moved: number;
  cognition_files_to_generate: number;
}
```

The plan JSON is saved to `.polaris/adoption-plan.json`. A human-readable Markdown rendering is saved alongside as `.polaris/adoption-plan.md`.

---

## 7. Rules for Existing Docs and Agent Instruction Files

### Existing Documentation

**What counts as a SmartDocs candidate:**
- Any `.md` or `.mdx` file not in generated_roots, cache_roots, fixture_roots, `node_modules/`, `.git/`
- Files larger than 100 bytes (below that threshold is likely a placeholder)
- Does not already reside in `smartdocs/`

**How to handle candidates:**
- Move to `smartdocs/raw/<original-filename>` (not directly to `doctrine/` or `specs/`)
- Preserve git history with `git mv` where available
- Record provenance in `.polaris/adoption-provenance.json`:
  ```json
  { "old_path": "docs/architecture.md", "new_path": "smartdocs/raw/architecture.md", "moved_at": "..." }
  ```
- Do not auto-promote. The smartdocs lifecycle (raw → candidate → active) requires human review.
- If a doc already has valid Polaris frontmatter (id, kind, status, owner), it may be classified higher than `raw`, but still requires human review before landing in `doctrine/active/`.

**What NOT to move:**
- `README.md` at repo root (leave in place; add to .polarisignore from atlas perspective or classify as `tracked-not-indexed`)
- `CHANGELOG.md`, `LICENSE`, `CONTRIBUTING.md` (infrastructure docs; leave in place)
- Files in `test/`, `fixtures/`, `__mocks__/` (not documentation)
- Generated docs (e.g., API reference output from typedoc/jsdoc)

### Agent Instruction Files

Detect the following files:
- `CLAUDE.md` (Claude Code instructions)
- `AGENTS.md` (OpenAI Agents SDK instructions)
- `.github/copilot-instructions.md` (GitHub Copilot)
- `.cursorrules` or `.cursor/rules/*.md` (Cursor)
- `.aider.conf.yml` or `AIDER.md` (Aider)
- Any file matching `**/GEMINI.md` (Gemini)

**Decision rules:**

| Condition | Action |
|---|---|
| File already has `<!-- polaris:delegate -->` marker or references POLARIS.md doctrine | `preserve` — already adapted |
| No Polaris doctrine exists yet in this repo | `preserve` — can't refactor until doctrine exists |
| Polaris doctrine exists, file is short (< 500 bytes) with generic instructions | `thin-adapter` — replace with delegation stub |
| Polaris doctrine exists, file is substantive (≥ 500 bytes) with repo-specific instructions | `migrate` — save to `smartdocs/raw/migrated-instructions/`, replace with thin adapter |

**Thin adapter format:**
```markdown
<!-- polaris:adapter — generated by polaris init --adopt -->
<!-- Original content preserved in smartdocs/raw/migrated-instructions/<filename> -->

This repository uses Polaris. For agent instructions, see the route-local POLARIS.md file
in the folder you are working in. For global runtime behavior, see the root POLARIS.md.
```

The thin adapter preserves the file at its original path so that the provider continues to load it. It just stops being a competing source of truth.

---

## 8. Atlas/Map Generation Rules for Adoption

### Initial indexing after adoption

Run `polaris map index` as the final pre-stage step (C5). Pass `--seed-cognition=false` during the first adoption run — cognition files were already created in C3 and should not be overwritten.

### Coverage expectations

- Adopted repos will have lower initial coverage than a Polaris-native repo. This is expected.
- Record the baseline in `.polaris/map/index.json` as `adoption_baseline_coverage_pct`.
- Do not enforce the normal `autoWriteAbove` threshold during the adoption run; all files should be indexed regardless.
- Files that cannot be confidently classified go to `needs-review.json`. These are adoption debt, not errors.

### Route stability rules

- Route names must be derived from **folder paths**, not filenames. `docs/architecture/adrs/001-decision.md` → route `docs/architecture/adrs`, not `001-decision`.
- Moved docs (from SmartDocs migration in C2) must have their new `smartdocs/raw/...` path indexed, not the old path.
- The `.polaris/adoption-provenance.json` lets the atlas reconcile old references during the first `map update` after adoption.

### Instruction file resolution during adoption

The `resolveInstructionFile()` walk in `src/map/atlas.ts` will naturally pick up newly created cognition files (C3) for source folders. No special handling is needed — the walk-up approach is already canonical.

---

## 9. Commit and Stage Policy

### New repo init

- Auto-stage all generated files.
- Print a suggested commit message: `chore: initialize Polaris structure`
- Do NOT auto-commit unless `--commit` flag is passed.
- No adoption-provenance.json is created (nothing was moved).

### Existing repo adoption

- Collect all adoption changes into a single staged set.
- Never mix runtime artifacts (`.polaris/runs/`, `.polaris/bootstrap/`, `.polaris/clusters/`) into the adoption commit. These must be in `.gitignore` before staging.
- Suggested commit message: `chore: adopt Polaris init — <N> files moved, <M> cognition files generated`
- Do NOT auto-commit unless `--commit` flag is passed.
- Staged change set should be coherent: if the adoption is interrupted mid-way (e.g., user ctrl-c after C2 but before C3), the partial state must be detectable and resumable.

### Resumability

Save step execution state into `.polaris/adoption-plan.json` (the `status` field on each `AdoptionStep`). On re-run of `polaris init --adopt`, check for an existing plan with incomplete steps and offer to resume from the last completed step rather than starting over.

### .gitignore additions (always applied)

Append during scaffold creation:
```
# Polaris runtime artifacts — do not commit
.polaris/runs/
.polaris/bootstrap/
.polaris/clusters/
.polaris/session-type
```

The atlas sidecar (`.polaris/map/`) and adoption artifacts (`.polaris/adoption-plan.json`, `.polaris/adoption-inventory.json`, `.polaris/adoption-provenance.json`) ARE committed — they are repository metadata, not runtime state.

---

## 10. Distribution-Ready Command Surface

The current `polaris init` command lives in `src/cli/init.ts` and handles provider detection for the development environment. For distributed use (users running Polaris on their own repos), the surface needs to be:

```
polaris init               → new repo init (empty/new state)
polaris init --adopt       → existing repo adoption flow
polaris init --status      → detect and print current repo state (read-only)
polaris init --resume      → resume interrupted adoption
```

The `--adopt` flag triggers the full Phase A → B → C flow. Without it, `polaris init` runs the simpler new-repo flow and exits early if the repo state is `existing` (printing a message: "This repo has existing content. Run polaris init --adopt to begin adoption.").

Keep this scoped to init/adoption. Full provider UX (wizard, interactive config, provider switching) is not part of this issue and should be a child of POL-256.

---

## 11. Implementation Children

Ordered from smallest dependency to largest. Each child is scoped for a single Codex or Copilot worker session.

| # | Issue title | Scope | Depends on |
|---|---|---|---|
| 1 | IMPL: Add repo state detection to `polaris init` | Detect empty/new/partial/existing/polaris-enabled. Read-only. Extend `src/cli/init.ts`. ~150 lines. | — |
| 2 | IMPL: Add read-only repo scanner (`RepoScanInventory`) | Scan package manager, source roots, docs, instruction files, generated/cache/fixture roots. Write `.polaris/adoption-inventory.json`. ~400 lines. | Child 1 |
| 3 | IMPL: Add adoption plan generator (`AdoptionPlan`) | Consume `RepoScanInventory` → produce `AdoptionPlan` JSON + Markdown. dry-run mode. ~300 lines. | Child 2 |
| 4 | IMPL: Add user approval gate to `polaris init --adopt` | Pause, display plan, require y/N. `--yes` flag for CI. ~80 lines. | Child 3 |
| 5 | IMPL: Add minimal provider config lock for adoption | Write `polaris.config.json` with dispatch disabled before any scan. Integrate with POL-256 approach (no-rotation, supervised mode). ~100 lines. | Child 1, POL-256 analysis |
| 6 | IMPL: Add SmartDocs migration step to adoption | Move SmartDocs candidates to `smartdocs/raw/`. `git mv` with fallback. Write `.polaris/adoption-provenance.json`. ~250 lines. | Child 4 |
| 7 | IMPL: Add folder cognition generation to adoption | Create POLARIS.md/SUMMARY.md templates for canonical folders. Skip generated/cache/fixture/sparse folders. ~200 lines. | Child 6 |
| 8 | IMPL: Add agent instruction file handler | Detect instruction files. Apply preserve/migrate/thin-adapter logic. Save originals to `smartdocs/raw/migrated-instructions/`. ~200 lines. | Child 4 |
| 9 | IMPL: Integrate atlas generation into adoption flow | Run `polaris map index` as C5 step. Record baseline coverage. ~80 lines. | Child 7, Child 8 |
| 10 | IMPL: Add adoption stage/commit finalization | Collect all adoption changes. Append `.gitignore` entries. Stage as coherent set. `--commit` flag support. Resume from partial state. ~200 lines. | Child 9 |

Children 5 through 10 can be worked in parallel once Children 1–4 are merged, as long as each worker operates on a different file surface.

---

## 12. Acceptance Criteria Mapping

| Criterion | Addressed by |
|---|---|
| Clearly separates new repo init from existing repo adoption | §2 vs §3; `polaris init` vs `polaris init --adopt` |
| Existing repo adoption starts with minimal provider config before scan | §3 Phase A, Step A1; §4 ordering invariants |
| User approval required before broad doc moves or instruction rewrites | §3 Phase B, Step B2; §6 schema `requires_approval` flag |
| Existing docs moved to SmartDocs raw/candidate before becoming canonical | §7 Existing Documentation rules |
| POLARIS.md/SUMMARY.md generation follows stable-folder rules | §3 Step C3; §7 exclusion list |
| Existing instruction files handled without becoming competing doctrine | §7 Agent Instruction Files rules; thin adapter format |
| Atlas/map generation included as part of adoption validation | §3 Step C5; §8 Atlas rules |
| Output produces small implementation children | §11 Implementation Children table |
