# .polaris/cognition/ — Staging Root

**Owner:** Foreman / Cognition Librarian  
**Source spec:** `smartdocs/specs/active/folder-cognition-staging-librarian.md` (POL-249)

---

## Purpose

This directory is the staging root for folder-local cognition work notes.

Workers write compact, folder-scoped notes to `.polaris/cognition/pending/<folder-slug>/` immediately before emitting the `complete` heartbeat. The cognition librarian reads staged notes, produces a sealed proposed patch (JSON result), and the foreman validates and applies it. Reconciled notes are archived to `.polaris/cognition/archive/<folder-slug>/`.

---

## Directory Contract

```
.polaris/cognition/
├── POLARIS.md           ← this file — staging root cognition contract
├── pending/             ← ephemeral; gitignored during normal execution
│   └── <folder-slug>/
│       └── <run-id>-<child-id>.md
└── archive/             ← durable provenance; committed
    └── <folder-slug>/
        ├── <run-id>-<child-id>.md   ← archived notes (immutable after move)
        └── cognition-index.json     ← reconciliation provenance index
```

---

## Worker Contract

Every worker MUST write exactly one note per child task, to:
```
.polaris/cognition/pending/<folder-slug>/<run-id>-<child-id>.md
```

### Required Frontmatter

```yaml
---
run_id: <run-id>
child_id: <child-id>
issue_id: <issue-id>
folder: <repo-relative-path>
folder_slug: <slug>
affected_files:
  - <path>
validation_performed: <string>
docs_impact: <none|polaris-update|summary-update|both|archive-only>
commit: <short-sha or "">
timestamp: <ISO8601>
---
```

### Folder Slug Convention

Derived from the repo-relative path with `/` replaced by `-`.  
Example: `src/loop/` → `src-loop`. Repository root → `root`.

### `docs_impact` Values

| Value | Meaning |
|---|---|
| `none` | No folder cognition update needed |
| `polaris-update` | `POLARIS.md` needs updating |
| `summary-update` | `SUMMARY.md` needs updating |
| `both` | Both need updating |
| `archive-only` | Historical evidence only; no file update needed |

---

## Librarian Contract

The cognition librarian:
- Reads staged notes from `pending/<folder-slug>/`
- Produces a sealed `CognitionLibrarianResult` (JSON — no direct file writes)
- Groups notes by `folder_slug`
- Skips folders where all notes have `docs_impact: none`

The foreman validates the result against 5 rules (file scope, doctrine bleed, size guard, confidence threshold, schema) before applying any patch.

---

## Gitignore Policy

```gitignore
# Cognition staging — ephemeral, not committed
.polaris/cognition/pending/

# Cognition archive — durable provenance, committed (no ignore entry)
```

---

## Related

- Spec: `smartdocs/specs/active/folder-cognition-staging-librarian.md`
- Implementation: `src/cognition/` (archive, librarian-dispatch, librarian-types)
- Parent issue: POL-249
