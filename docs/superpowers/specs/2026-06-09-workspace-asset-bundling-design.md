# Workspace Asset Bundling for `polaris init --adopt`

**Date:** 2026-06-09  
**Status:** Approved  
**Author:** Phil Meaux / LSC Technologies

---

## Problem

`polaris init --adopt` produces config and map artifacts but does not install the workspace assets Polaris requires to operate: skills, roles, smartdocs structure, and authority files. After adoption a repo has no `.polaris/skills/`, no `.polaris/roles/`, no `POLARIS_RULES.md`, and agent instruction files (CLAUDE.md, AGENTS.md, etc.) either point nowhere useful or retain their original unstructured content.

---

## Goal

After `polaris init --adopt` completes, the target repo is fully Polaris-operable:

- All Polaris skills and roles are installed
- The smartdocs folder structure exists
- Agent instruction files point to `POLARIS_RULES.md` as the global governance authority
- `POLARIS_RULES.md` is present with Polaris navigation rules
- The file-level map (atlas) is built
- The symbol graph is built (or failure is clearly reported)
- Existing agent file content is preserved as genesis doctrine (with user consent)

---

## Approach: Static `workspace/` Directory Bundled at Build Time

Workspace assets live in `src/workspace/` in the Polaris source tree. The build script copies them to `dist/workspace/`. Since `package.json` already includes `"dist"` in `files`, they ship automatically with the npm package.

At runtime `init --adopt` resolves `dist/workspace/` relative to the executing `dist/cli/index.js` and copies assets into the target repo.

---

## Source Layout

```
src/workspace/
  POLARIS_RULES.md                    ← Polaris navigation rules (extracted from Polaris CLAUDE.md)
  .polaris/
    skills/                           ← all 10 Polaris skills (SKILL.md, chain.md, steps/)
    roles/                            ← all 7 role definition files
    session-type                      ← session type marker
  smartdocs/
    doctrine/
      active/.gitkeep
    specs/
      active/.gitkeep
      archive/.gitkeep
    architecture/.gitkeep
    decisions/.gitkeep
    runtime/.gitkeep
    audits/.gitkeep
```

### Build script change

```json
"build": "tsc && cp -r src/workspace dist/workspace"
```

### POLARIS_RULES.md content

Contains Polaris skill command routing (recognized command forms, routing table, skill packet resolution), the cluster/child execution model, runtime behavior rules, and canon discovery instructions. This is the content currently maintained in the Polaris repo's own `CLAUDE.md` project instructions — centralized here so every adopted repo gets the same rules from the package.

---

## Adoption Phase Ordering

The adoption flow is restructured into six phases:

```
Phase A   Preflight + scaffold root authority files
Phase B   Install bundled workspace assets: skills, roles, smartdocs skeleton
Phase C1  Atlas / file-map baseline
Phase C2  Graph build (automatic, non-blocking) + status recorded
Phase D   Agent file reconciliation + genesis doctrine prompt
Phase E   Adoption report
Phase F   Safe stage + optional commit
```

### Phase A — Preflight + scaffold root authority files

Runs before any scan or install. Creates root surfaces only if absent (never overwrites):

- `POLARIS.md` — repo operational guide (draft marker `<!-- polaris:draft -->`), with appended section:
  ```markdown
  ## Polaris Rules
  See POLARIS_RULES.md for canonical Polaris navigation and routing rules.
  ```
- `SUMMARY.md` — informational context (draft marker)
- `POLARIS_RULES.md` — Polaris navigation rules (copied from bundled workspace)
- `CLAUDE.md` — thin pointer stub (only if file is absent)
- `AGENTS.md` — thin pointer stub (only if file is absent)
- `.github/copilot-instructions.md` — thin pointer stub (only if file is absent)

Thin pointer stub content:
```markdown
# Agent Instructions

Read [POLARIS_RULES.md](POLARIS_RULES.md) before beginning any work.
```

### Phase B — Install bundled workspace assets

Copies from `dist/workspace/` into the target repo. Each asset is skipped if already present (never overwrites). Skips any destination path whose parent is a symlink.

Assets installed:
- `.polaris/skills/<name>/` — each skill directory, skip-if-exists per skill
- `.polaris/roles/<file>` — each role file, skip-if-exists
- `.polaris/session-type` — skip if exists
- `smartdocs/<subfolder>/` — creates missing subdirectories with `.gitkeep` only

### Phase C1 — Atlas / file-map baseline

Runs atlas against the target repo to produce:
- `.polaris/map/file-routes.json`
- `.polaris/map/index.json`
- `.polaris/map/needs-review.json`

This is a fast, file-level scan. Already implemented in `finalizeAdoption`.

### Phase C2 — Graph build

Triggers `polaris graph build` automatically on the target repo. This is a heavier Tree-sitter parse that extracts functions, methods, classes, and call edges into a SQLite store. It may take several minutes on large repos.

Output: prints a progress indicator during the build.

**Graph build is non-blocking.** The adoption continues regardless of graph outcome. The result is recorded for Phase E:

- **Success:** records files parsed, symbols extracted, edges resolved.
- **Failure or skip** (e.g., Tree-sitter bindings unavailable, timeout, no supported files): records the reason and the follow-up command (`polaris graph build`) to run manually.

### Phase D — Agent file reconciliation + genesis doctrine prompt

**Thin pointer detection:** A file is considered a thin pointer if all of the following are true:
- Non-empty, non-comment, non-whitespace lines number ≤ 3
- At least one line contains the string `POLARIS_RULES.md` or `POLARIS.md`
- No line contains independent behavioral doctrine (i.e., imperative rules, tool configuration, or environment setup that is not a reference to another file)

For each agent instruction file (CLAUDE.md, AGENTS.md, `.github/copilot-instructions.md`):

1. **If absent** — already created as thin pointer in Phase A. No action.
2. **If present and is already a thin pointer** — no action.
3. **If present and has meaningful content** — prompt user:
   ```
   CLAUDE.md has existing content. Compress and archive it as a genesis doctrine document?
   This preserves your rules in smartdocs/doctrine/active/ and replaces CLAUDE.md with a pointer to POLARIS_RULES.md.
   Requires ANTHROPIC_API_KEY. [Y/n]:
   ```
   - **Accepted:** Polaris calls the Anthropic API (requires `ANTHROPIC_API_KEY` env var; aborts with a clear error if missing) to distill the existing file into a concise bullet-point rule set. The distilled content is written to `smartdocs/doctrine/active/<YYYY-MM-DD>-genesis-agent-doctrine.md`. CLAUDE.md is replaced with a thin pointer + a comment:
     ```
     <!-- genesis doctrine archived: smartdocs/doctrine/active/<date>-genesis-agent-doctrine.md -->
     ```
     *(Note: this section is also written during Phase A scaffold — Phase D appends it only if POLARIS.md existed before adoption and the section is absent.)*
   - **Refused:** A single-line HTML comment is prepended to the existing file:
     ```
     <!-- See [POLARIS_RULES.md](POLARIS_RULES.md) for repo instructions -->
     ```
     Existing content is preserved below unchanged.

**Provenance:** Every agent file processed in Phase D appends a record to `.polaris/adoption-provenance.json` under the `genesis_reconcile_actions` key. Each record includes: `source_path`, `backup_path` (genesis doc path for compressed, null otherwise), `decision`, `timestamp`, and `migration_outcome`.

The `adopt-instructions` path (for all supported instruction surfaces beyond the three Phase D agent files) similarly appends records to `adoption-provenance.json` under `instruction_file_actions`, with fields: `source_path`, `backup_path` (archived raw path), `decision`, `timestamp`.

**Baseline adoption does not require Anthropic or any external provider.** Genesis doctrine compression (Anthropic distillation) is an optional enhancement. If declined or unavailable, original instruction content is either preserved in-place (refused path) or archived losslessly to `smartdocs/raw/migrated-instructions/` (adopt-instructions path), and adoption succeeds either way.

All agent files end up pointing to `POLARIS_RULES.md` as the global governance authority. `POLARIS.md` remains the route-local operational guide and references `POLARIS_RULES.md` for canonical Polaris navigation rules.

### Phase E — Adoption report

Prints a structured summary with the following categories per asset type:

| Category | Meaning |
|---|---|
| `installed` | Asset was not present; created from bundled workspace |
| `already-present` | Asset existed and matched expected shape; no action taken |
| `skipped` | Asset path beyond a symlink; safely skipped |
| `conflicted` | Asset existed with unexpected content; left untouched, flagged |
| `compressed` | Agent file compressed to genesis doctrine; user accepted |
| `refused` | User declined genesis doctrine compression; pointer prepended only |
| `graph-success` | Graph build succeeded; includes symbol/edge counts |
| `graph-failed` | Graph build failed; includes reason + follow-up command |
| `graph-skipped` | Graph build skipped (e.g., no supported language files found) |

Report is printed to stdout and written to `.polaris/runs/adoption-report-<timestamp>.json`.

### Phase F — Safe stage + optional commit

Stages all adoption outputs, filtering paths beyond symlinks. Excludes runtime artifacts (mutation-queue.json, pre-pol-* state files, cognition/pending). Prompts for optional commit.

---

## Asset Maintenance

When Polaris skills or roles are updated in the source repo:

1. Update files under `src/workspace/.polaris/skills/` or `src/workspace/.polaris/roles/`
2. Bump the package version
3. `npm publish`

Adopted repos that want the updated skills run `polaris workspace update` (future command — out of scope for this spec).

---

## Out of Scope

- `polaris workspace update` command for syncing skills after initial adoption
- Selective skill installation (install only specific skills)
- Custom workspace templates (non-default skill/role sets)
- Graph build progress streaming (basic indicator only for now)

---

## Testing

- Unit: `installWorkspaceAssets(repoRoot, workspaceDir)` — verify installed/already-present/skipped/conflicted outcomes; verify smartdocs subdirs created correctly
- Unit: `isThinPointer(content)` — verify whitespace/comment-only lines are ignored; verify ≤ 3 meaningful lines + POLARIS.md reference detection
- Unit: `reconcileAgentFile(filePath, repoRoot)` — verify genesis prompt flow (accepted/refused); verify ANTHROPIC_API_KEY absence aborts with clear error
- Unit: Phase ordering in `runInit` — verify phases execute in A → B → C1 → C2 → D → E → F order
- Unit: graph result recording — success path records counts; failure path records reason + follow-up command
- Integration: full dry-run adoption on a temp repo — verify all assets present after run
- Build: verify `dist/workspace/` present after `npm run build`
