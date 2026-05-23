# Polaris Local Instructions/Wiki Layer — Design Spec

**Status:** Analysis deliverable  
**Parent:** POL-41  
**Date:** 2026-05-23

---

## 1. Purpose and Scope

The Polaris sidecar atlas (`file-routes.json`) answers: *where is this file and what route owns it?*

The local instructions layer answers: *what does this part of the repo currently do, what belongs here, what should agents read before editing, and what assumptions must stay aligned?*

These are complementary, not overlapping:

| Layer | Primary format | Primary consumer | Answers |
|---|---|---|---|
| Sidecar atlas | JSON (`file-routes.json`) | Polaris tooling | Route/domain/taskchain ownership |
| Local instructions | Markdown (`POLARIS.md`) | Agents + humans | Semantic purpose, editing rules, linked context |

---

## 2. File Naming Convention

### Recommended name: `POLARIS.md`

Rationale:
- Unambiguous — not confused with `README.md` (project-level) or `INSTRUCTIONS.md` (ambiguous origin)
- Communicates the semantic role (Polaris-maintained guidance)
- All-caps convention signals infrastructure files agents should read first
- Short enough to include in bootstrap packets without line noise

### Placement rules

- One `POLARIS.md` per directory, placed at the root of that directory
- `POLARIS.md` at the repo root covers top-level concerns and cross-cutting guidance
- Subdirectory `POLARIS.md` files are scoped to that directory and its children
- `POLARIS.md` files do not nest semantically — each file is standalone for its directory

### Not used

- `INSTRUCTIONS.md` — avoided because EVO already uses this name with distinct semantics
- `WIKI.md` — avoided, sounds like human-facing documentation not agent guidance
- `.polaris-instructions` — dotfiles are hidden; these should be visible to humans and agents

---

## 3. Content Model

Each `POLARIS.md` should address the following sections (all optional, progressive):

```markdown
# <Directory name>

## Purpose
What this directory currently does. One paragraph. Present tense.

## What belongs here
Types of files/modules that should live in this directory.

## What does not belong here
Common misplacements to avoid.

## Editing rules
Local conventions agents must follow when modifying files here.

## Architecture assumptions
Invariants that must stay aligned across changes.

## Read before editing
Links to specs, docs, issues, or map entries agents should load before touching this directory.

## Related routes
Sidecar atlas routes that cover this directory (e.g., `polaris.map`).
```

Sections may be omitted if not applicable. A minimal `POLARIS.md` may contain only **Purpose** and **Read before editing**.

---

## 4. Sidecar Map Linkage Model

The sidecar atlas entry for a file or directory should carry an optional `instructionFile` field pointing to the nearest applicable `POLARIS.md`:

```json
{
  "src/map/atlas.ts": {
    "domain": "map",
    "route": "src/map",
    "taskchain": "polaris-map",
    "confidence": 0.95,
    "classification": "indexed",
    "instructionFile": "src/map/POLARIS.md",
    "last_updated": "2026-05-23T00:00:00.000Z"
  }
}
```

### Linkage resolution rules

1. If a `POLARIS.md` exists in the file's directory → link it directly.
2. If not, walk up to the nearest ancestor directory with a `POLARIS.md`.
3. If none found, omit `instructionFile` — this is not an error.

`polaris map update --changed` resolves and writes `instructionFile` when updating entries for changed files.  
`polaris map index` resolves `instructionFile` for all entries during initial indexing.

### `index.json` coverage metric

`index.json` gains a new field:

```json
{
  "instructionCoverage": {
    "routesCovered": 5,
    "routesTotal": 8,
    "coveragePercent": 62.5
  }
}
```

This lets `polaris map status` report instruction file coverage alongside route coverage.

---

## 5. Progressive Adoption Strategy

### Phase 0 — Seed root file only

Create `POLARIS.md` at the repo root. This file covers top-level structure, key directories, and cross-cutting constraints. All other directories are uncovered — not a failure.

### Phase 1 — Seed major source directories

Cover directories that agents edit most frequently:
- `src/map/`
- `src/loop/`
- `src/cli/`
- `src/finalize/`
- `src/config/`

### Phase 2 — Touch-time creation

When an agent starts work on a directory that lacks `POLARIS.md`, Polaris can optionally generate a draft:

```shell
polaris docs seed-instructions src/ignore
```

The draft is populated from:
- Sidecar atlas route entry for the directory
- Directory contents (file names and types)
- Nearby specs/docs referenced in `file-routes.json`
- Adjacent `POLARIS.md` content for context

The agent reviews and commits the draft as part of the session.

### Phase 3 — Validation enforcement

Once coverage targets are met, enable validation in `polaris.config.json`:

```json
{
  "docs": {
    "instructionFiles": {
      "required": ["src/map", "src/loop", "src/cli", "src/finalize"],
      "warnOnMissing": true,
      "failFinalizeOnMissing": false
    }
  }
}
```

`failFinalizeOnMissing: true` blocks `polaris finalize` if a required directory lacks `POLARIS.md`.

---

## 6. Staleness and Alignment Validation

### Staleness signals

Polaris detects potential staleness by checking whether a directory's `POLARIS.md` was updated relative to changes in that directory. Signals:

| Signal | Severity | Description |
|---|---|---|
| `POLARIS.md` not updated when ≥3 files in its directory changed within the current commit/PR (as determined by SCM commit history, i.e., files modified in the same commit or PR diff) | warn | Likely stale — may not reflect new additions |
| File types or patterns appeared that are not mentioned | warn | New responsibilities may be undocumented |
| Route ownership changed in sidecar atlas | warn | Linked routes may now be wrong |
| A file listed in "Read before editing" was moved/deleted | error | Broken link in instructions |
| `instructionFile` pointer in atlas references a non-existent path | error | Map entry is broken |

### `polaris docs validate-instructions`

Proposed command that runs staleness checks and reports:

```shell
polaris docs validate-instructions [--path <dir>] [--fix]
```

Output format:
```text
POLARIS.md validation report:
  src/map/POLARIS.md      OK
  src/loop/POLARIS.md     WARN: 4 files changed since last instruction update
  src/ignore/             MISSING (warn only)
  POLARIS.md              OK
```

`--fix` re-runs `polaris docs seed-instructions` for stale or missing files, producing draft updates.

### No auto-overwrite

Polaris never silently overwrites a human-edited `POLARIS.md`. All `--fix` output goes to a draft (`POLARIS.draft.md`) for review.

---

## 7. Proposed CLI Commands

All commands live under `polaris docs`:

| Command | Purpose |
|---|---|
| `polaris docs seed-instructions <path>` | Generate a draft `POLARIS.md` for the given directory using atlas signals |
| `polaris docs seed-instructions --all` | Generate drafts for all un-covered directories |
| `polaris docs update-instructions --changed` | Regenerate drafts for directories where files changed since last instruction update |
| `polaris docs validate-instructions` | Check all `POLARIS.md` files for staleness and broken links |
| `polaris docs validate-instructions --path <dir>` | Scoped validation |
| `polaris docs validate-instructions --fix` | Produce draft fixes for stale/missing files |

All commands are additive — they write drafts or reports, never silently modify existing files.

---

## 8. Integration with `polaris map query`

`polaris map query` gains an `--include-instructions` flag:

```shell
polaris map query src/map/atlas.ts --include-instructions
```

Output adds an `instructionFile` field and optionally inlines the `POLARIS.md` content:

```json
{
  "path": "src/map/atlas.ts",
  "route": "src/map",
  "domain": "map",
  "taskchain": "polaris-map",
  "instructionFile": "src/map/POLARIS.md",
  "instructionContent": "# src/map\n\n## Purpose\n..."
}
```

`--include-instructions` is opt-in — default query output is unchanged to avoid context bloat.

Agents constructing bootstrap packets should call `polaris map query --include-instructions` for each directory they'll be editing, and inline the instruction content into the packet context.

---

## 9. Human-Facing vs Agent-Facing Mode

`POLARIS.md` files are intentionally visible to both humans and agents. Unlike sidecar JSON, they are tracked in source control and appear in the repo tree.

To avoid noise for human contributors who don't work with agents:

1. `POLARIS.md` files should be meaningful even without AI context — they function as concise directory READMEs.
2. Autogenerated drafts are clearly marked `<!-- polaris:draft -->` at the top. Human-reviewed files remove this comment.
3. `polaris.config.json` may set `docs.instructionFiles.humanFacing: false` to suppress `POLARIS.md` from being committed to source control — instead, storing them in `.polaris/instructions/` (gitignored). This mode is for teams that want agent-facing guidance without visible docs. Default is `true` (committed to source).

---

## 10. Follow-Up Implementation Issues

This design should be decomposed into the following implementation children:

| # | Title | Scope |
|---|---|---|
| POL-41a | Add `instructionFile` field to sidecar atlas linkage | Modify `src/map/atlas.ts` and `update.ts` to resolve and write `instructionFile` during index/update |
| POL-41b | Implement `polaris docs seed-instructions` | CLI command: generate draft `POLARIS.md` from atlas signals |
| POL-41c | Implement `polaris docs validate-instructions` | CLI command: staleness checks, broken link detection, draft --fix output |
| POL-41d | Add `--include-instructions` to `polaris map query` | Extend query output to inline instruction file content |
| POL-41e | Add instruction coverage to `index.json` and `polaris map status` | Track `instructionCoverage` metric |
| POL-41f | Seed initial `POLARIS.md` files for major src directories | Create root and `src/{map,loop,cli,finalize,config}` instruction files |

These can be implemented as a separate cluster (POL-42 parent) or appended to an existing cluster depending on release timing.

---

## 11. Success Criteria

This design is complete when:

- `POLARIS.md` naming convention is adopted and seeded for key directories
- Sidecar atlas entries carry `instructionFile` pointers
- `polaris docs seed-instructions` can generate a useful draft from atlas signals alone
- `polaris docs validate-instructions` surfaces stale/missing files without false positives
- `polaris map query --include-instructions` allows agents to load semantic guidance in bootstrap packets
- Instruction coverage is tracked in `index.json` and visible in `polaris map status`
- Design covers progressive adoption (zero required on day one, stricter opt-in later)
