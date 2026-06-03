# Cognition Staging Root

**Purpose:** Ephemeral staging layer for worker-written cognition notes and librarian reconciliation.

**Status:** Active (POL-284)

---

## Overview

This folder is the staging root for the Polaris cognition update model. Workers write compact, folder-scoped notes after completing child tasks. A cognition librarian agent reconciles those staged notes into durable folder cognition (`POLARIS.md` / `SUMMARY.md`), producing a sealed proposed patch (never writing directly).

---

## Directory Structure

```
.polaris/cognition/
├── POLARIS.md           ← This file (staging root contract)
├── pending/             ← Active staging queue (gitignored — ephemeral)
│   └── <folder-slug>/
│       └── <run-id>-<child-id>.md   ← Worker note files
└── archive/             ← Durable provenance records (committed)
    └── <folder-slug>/
        ├── <run-id>-<child-id>.md   ← Archived notes (immutable)
        └── cognition-index.json     ← Reconciliation provenance
```

---

## Worker Contract

**When:** Every worker writes one note per child task completion.

**Where:** `.polaris/cognition/pending/<folder-slug>/<run-id>-<child-id>.md`

**Folder slug:** Derived from repo-relative path with `/` replaced by `-`. Example: `src/loop/` → `src-loop`. Root maps to `root`.

**Required frontmatter fields:**
```yaml
---
run_id: <run-id>
child_id: <child-id>
issue_id: <issue-id>
folder: <repo-relative-path>
folder_slug: <slug>
affected_files:
  - <path>
docs_impact: <none|polaris-update|summary-update|both|archive-only>
commit: <short-sha or "">
timestamp: <ISO8601>
---
```

**Body:** ≤150 words. Describe **what changed**, not how. State **why** only if non-obvious. Written for a librarian agent, not a human reviewer.

---

## Cognition Librarian Contract

**Role:** Distinct from worker and foreman. Sole responsibility: reconcile staged notes into durable folder cognition.

**Authorized to read:**
- All `.polaris/cognition/pending/<folder-slug>/` notes (assigned scope)
- Current `POLARIS.md` for target folder
- Current `SUMMARY.md` for target folder (if present)
- `cognition-index.json` for target folder (if present)

**NOT authorized to:**
- Write directly to `POLARIS.md` or `SUMMARY.md`
- Read files outside assigned folder scope
- Read source code (beyond worker note references)
- Access `.taskchain_artifacts/` or workspace state

**Output:** Sealed JSON result file containing proposed patches (never direct writes).

---

## Gitignore Policy

- `pending/` is ephemeral runtime state → **MUST be gitignored**
- `archive/` and `cognition-index.json` are durable provenance → **MUST be committed**

Entry in `.gitignore`:
```
# Cognition staging — ephemeral, not committed
.polaris/cognition/pending/
```

---

## Related Specs

- `smartdocs/specs/active/folder-cognition-staging-librarian.md` — Full reconciliation model
- `smartdocs/specs/active/foreman-worker-architecture.md` — Foreman/worker dispatch
- `smartdocs/specs/active/worker-session-contract.md` — Worker session contract
- `smartdocs/specs/active/worker-telemetry-spec.md` — Telemetry schema
