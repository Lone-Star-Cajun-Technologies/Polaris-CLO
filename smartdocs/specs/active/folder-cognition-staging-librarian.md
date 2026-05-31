---
kind: spec
status: active
source: POL-241
created: 2026-05-31
implements: POL-249
related:
  - POL-241
  - POL-233
  - POL-240
depends_on:
  - foreman-worker-architecture.md
  - worker-session-contract.md
  - worker-telemetry-spec.md
source_paths:
  - .polaris/cognition/
  - src/cognition/
  - src/loop/
---

# Folder-Local Work Note Staging and Cognition Librarian Reconciliation Model

**Status:** Authoritative spec
**Issue:** POL-249 (parent), POL-241 (analysis)
**Cluster:** POL-249
**Created:** 2026-05-31

---

## Overview

This spec defines the staged cognition update model for Polaris. Workers write compact, folder-scoped notes after completing each child task. A cognition librarian agent reconciles those staged notes into durable folder cognition (`POLARIS.md` / `SUMMARY.md`) — producing a sealed proposed patch, never writing directly. The foreman validates and applies the patch. Reconciled notes are archived.

This replaces the current pattern where workers mutate `POLARIS.md` / `SUMMARY.md` directly without a review layer.

### Model Flow

```
Worker completes child
  └─ writes compact work note → .polaris/cognition/pending/<folder>/

Cognition librarian (dispatched by foreman)
  └─ reads staged notes
  └─ produces sealed proposed patch (JSON result — no direct writes)

Foreman validates patch
  └─ checks file scope, doctrine bleed, size guard, confidence threshold
  └─ applies patch if valid, rejects otherwise

Reconciled notes archived
  └─ .polaris/cognition/archive/<folder>/
  └─ per-folder cognition-index.json updated
```

---

## 1. Staging Folder Layout

### 1.1 Canonical Paths

| Path | Purpose |
|---|---|
| `.polaris/cognition/pending/` | Active staging root — worker-written notes awaiting reconciliation |
| `.polaris/cognition/pending/<folder-slug>/` | Per-folder staging queue |
| `.polaris/cognition/archive/` | Archive root — reconciled notes |
| `.polaris/cognition/archive/<folder-slug>/` | Per-folder archive |
| `.polaris/cognition/archive/<folder-slug>/cognition-index.json` | Per-folder reconciliation provenance index |

**Namespace rationale:** `.polaris/cognition/` uses the `.polaris/` runtime namespace (not route noise). This keeps staged notes separate from canonical folder cognition (`POLARIS.md` / `SUMMARY.md`) and from SmartDocs content (`smartdocs/`).

**Folder slug convention:** Derived from the repo-relative path with `/` replaced by `-`. Example: `src/loop/` → `src-loop`. The root of the repo maps to `root`.

### 1.2 Directory Contract

```
.polaris/cognition/
├── POLARIS.md           ← staging root cognition (see §1.3)
├── pending/
│   ├── <folder-slug>/
│   │   └── <run-id>-<child-id>.md   ← worker note files
│   └── ...
└── archive/
    ├── <folder-slug>/
    │   ├── <run-id>-<child-id>.md   ← archived notes (immutable after move)
    │   └── cognition-index.json     ← reconciliation provenance
    └── ...
```

### 1.3 `.polaris/cognition/POLARIS.md`

This file defines the staging root's purpose and the worker/librarian contracts. Workers read it to understand where to write notes; the librarian reads it for scope constraints. It is committed as part of POL-250's implementation.

### 1.4 Gitignore Policy

Pending notes (`pending/`) are ephemeral runtime state. They MUST be gitignored during normal execution. Archive notes and `cognition-index.json` files are durable provenance records and MUST be committed as part of delivery.

```gitignore
# Cognition staging — ephemeral, not committed
.polaris/cognition/pending/

# Cognition archive — durable provenance, committed
# (no ignore entry — archive/ is tracked by default)
```

---

## 2. Worker Note Contract

### 2.1 When Workers Write Notes

Every worker MUST write one note per child task completion, immediately before emitting the `complete` heartbeat. The note is written to:

```
.polaris/cognition/pending/<folder-slug>/<run-id>-<child-id>.md
```

The `<folder-slug>` corresponds to the primary folder affected by the child's implementation. If multiple folders are affected, choose the folder containing the most changed files. Workers MUST NOT write multiple notes for a single child task.

### 2.2 Required Frontmatter Fields

```yaml
---
run_id: <run-id>               # from worker packet
child_id: <child-id>           # from worker packet
issue_id: <issue-id>           # from worker packet (e.g., "POL-249")
folder: <repo-relative-path>   # primary folder affected (e.g., "src/loop/")
folder_slug: <slug>            # derived slug (e.g., "src-loop")
affected_files:                # list of repo-relative paths changed
  - <path>
  - <path>
validation_performed: <string> # brief description of validation run
docs_impact: <enum>            # see §2.3
commit: <short-sha or "">      # git short SHA if committed, else empty
timestamp: <ISO8601>
---
```

### 2.3 `docs_impact` Enum

| Value | Meaning |
|---|---|
| `none` | No folder cognition update needed |
| `polaris-update` | `POLARIS.md` needs updating (workflow, rules, or constraints changed) |
| `summary-update` | `SUMMARY.md` needs updating (current-state understanding changed) |
| `both` | Both `POLARIS.md` and `SUMMARY.md` need updating |
| `archive-only` | Change is historical evidence only; neither file needs updating |

### 2.4 Prose Body Requirements

The prose body MUST:
- Be ≤150 words.
- Describe **what changed**, not how (no transcript).
- State the **why** only if non-obvious.
- Not duplicate frontmatter fields.
- Be written for a future librarian agent as audience, not a human reviewer.

**Anti-patterns to avoid:**
- Narrating execution steps ("First I read the file, then I…")
- Duplicating commit message content verbatim
- Including validation command output

### 2.5 Minimal Acceptable Note

```markdown
---
run_id: polaris-run-pol-250-2026-05-31-001
child_id: POL-250
issue_id: POL-250
folder: .polaris/cognition/
folder_slug: polaris-cognition
affected_files:
  - .polaris/cognition/POLARIS.md
  - .polaris/cognition/pending/.gitkeep
  - .polaris/cognition/archive/.gitkeep
validation_performed: directory structure verified, POLARIS.md content reviewed
docs_impact: polaris-update
commit: ""
timestamp: 2026-05-31T16:00:00.000Z
---

Created `.polaris/cognition/` staging root with `pending/` and `archive/` subdirectories. Added `POLARIS.md` defining the staging contract for worker note placement and librarian access scope. Gitignore entry added for `pending/` (ephemeral). Archive directories are tracked.
```

---

## 3. Cognition Librarian Role

### 3.1 Role Identity

The cognition librarian is a **distinct role** from:
- The worker role (which implements code and infrastructure)
- The SmartDocs librarian (which promotes docs through ingest pipelines)
- The foreman (which orchestrates execution)

The cognition librarian's sole responsibility is to reconcile staged worker notes into durable folder cognition. It is defined by a packet/result contract (see §3.3) and can be executed by any provider (Claude, Gemini, Copilot, etc.).

### 3.2 What the Librarian May Read

The cognition librarian is authorized to read:
- All `.polaris/cognition/pending/<folder-slug>/` note files it has been assigned
- The current `POLARIS.md` for the target folder
- The current `SUMMARY.md` for the target folder (if present)
- The `cognition-index.json` for the target folder (from archive, if present)
- This spec document

The librarian is NOT authorized to:
- Write directly to any `POLARIS.md` or `SUMMARY.md`
- Read files outside its assigned folder scope
- Read source code (beyond what the worker note references in `affected_files`)
- Access `.taskchain_artifacts/` or other workspace state

### 3.3 Librarian Packet Contract

The foreman dispatches the librarian with a sealed packet containing:

```typescript
interface CognitionLibrarianPacket {
  run_id: string;
  dispatch_id: string;
  role: "cognition-librarian";
  folder: string;                // repo-relative folder path
  folder_slug: string;           // derived slug
  note_paths: string[];          // paths to pending notes to reconcile
  polaris_md_path: string;       // path to current POLARIS.md
  summary_md_path: string | null; // path to current SUMMARY.md (null if absent)
  cognition_index_path: string;  // path to cognition-index.json (may not exist yet)
  result_path: string;           // where to write the sealed result
  constraints: CognitionConstraints;
}

interface CognitionConstraints {
  max_polaris_addition_lines: number;  // default: 20
  max_summary_addition_lines: number; // default: 30
  require_confidence_threshold: number; // default: 0.75 (0.0–1.0)
  allowed_files: string[];             // only these files may be proposed for update
}
```

### 3.4 Librarian Result Contract

The librarian writes a sealed JSON result file:

```typescript
interface CognitionLibrarianResult {
  run_id: string;
  dispatch_id: string;
  role: "cognition-librarian";
  folder: string;
  folder_slug: string;
  notes_reconciled: string[];          // paths to notes that were processed
  confidence: number;                  // 0.0–1.0
  proposed_patches: CognitionPatch[];  // proposed changes (may be empty)
  archive_actions: ArchiveAction[];    // notes to move to archive
  status: "success" | "no-change" | "low-confidence" | "failure";
  failure_reason?: string;
}

interface CognitionPatch {
  file: string;           // repo-relative path (must be in packet allowed_files)
  action: "update" | "create";
  proposed_content: string;  // full proposed content (not a diff)
  change_summary: string;    // ≤50 word summary of what changed
}

interface ArchiveAction {
  note_path: string;    // source path in pending/
  archive_path: string; // destination path in archive/
}
```

**Invariant:** The librarian NEVER writes to `POLARIS.md`, `SUMMARY.md`, or any source file directly. All proposed changes are in the sealed result. The foreman applies them.

---

## 4. Reconciliation Semantics

### 4.1 When to Update `POLARIS.md`

Update `POLARIS.md` only when all of the following are true:
1. The child touched files in that folder (not a distant folder).
2. The change materially affects: folder responsibilities, commands/workflows, execution constraints, ownership/routing, or operational behavior.
3. The current `POLARIS.md` content is actually wrong or incomplete as a result.

Do NOT update for: formatting fixes, comment changes, tiny refactors, internal implementation details, or any change that leaves the operational guidance still accurate.

### 4.2 When to Update `SUMMARY.md`

Update `SUMMARY.md` when:
- Linked docs/specs changed significantly.
- Canon relationships changed.
- Architecture meaning changed.
- Doctrine/spec linkage changed.

Do NOT update for: ephemeral execution events, minor bug fixes, test additions without behavior change.

`SUMMARY.md` is a current-state compression, not a changelog. The librarian MUST NOT append event descriptions — it must synthesize or replace stale content.

### 4.3 When to Archive Only

Archive without updating any cognition file when:
- `docs_impact: none` or `docs_impact: archive-only` in all reconciled notes.
- All notes are redundant with already-current folder cognition.
- The librarian confidence falls below the threshold.

### 4.4 Staleness and Supersession

The librarian MUST identify and remove stale content in `SUMMARY.md` when worker notes describe behavior that contradicts what is summarized. Removal of stale content is preferred over appending corrections.

---

## 5. Archive and Provenance Model

### 5.1 Archive On Reconciliation

After the foreman applies a librarian result, all `notes_reconciled` are moved from `pending/<folder-slug>/` to `archive/<folder-slug>/`. The file names are preserved.

### 5.2 `cognition-index.json` Schema

Each folder's archive directory contains a `cognition-index.json`:

```typescript
interface CognitionIndex {
  folder: string;
  folder_slug: string;
  last_reconciled_at: string; // ISO8601
  reconciliation_records: ReconciliationRecord[];
}

interface ReconciliationRecord {
  run_id: string;
  reconciled_at: string; // ISO8601
  notes_archived: string[];      // archive-relative filenames
  patches_applied: string[];     // files updated (empty if no-change)
  librarian_confidence: number;
  status: "applied" | "no-change" | "rejected";
  rejection_reason?: string;
}
```

### 5.3 Linking `POLARIS.md` / `SUMMARY.md` to Archive

When a reconciliation cycle produces a meaningful update, the librarian MAY add a brief provenance comment at the bottom of the updated file:

```markdown
<!-- cognition: last reconciled 2026-05-31, run polaris-run-pol-250-... -->
```

This comment is informational only. It MUST NOT appear in operational guidance sections. It is stripped during SmartDocs promotion if present.

### 5.4 Archive Retention

Archive notes are retained indefinitely. The `cognition-index.json` is the navigable index. Raw archive notes are not expected to be read directly by agents during normal execution — only by audit/review processes.

---

## 6. Validation and Safety Rules (Foreman)

The foreman validates librarian output before applying any patch. All checks are blocking unless noted.

### 6.1 File Scope Check

**Rule:** Every `proposed_patches[].file` MUST appear in the packet's `constraints.allowed_files`.

**Failure action:** Reject the entire result; archive notes as `rejected`; log `COGNITION_SCOPE_VIOLATION`.

### 6.2 Doctrine Bleed Check

**Rule:** No proposed patch may modify `POLARIS.md` or `SUMMARY.md` in a folder that was NOT in `note_paths`' folder slugs.

**Failure action:** Reject the patch entry (not the full result); skip applying that patch; continue with others.

### 6.3 Size Guard

**Rule:** The proposed content for any `POLARIS.md` addition must not exceed `constraints.max_polaris_addition_lines` net new lines. Same for `SUMMARY.md` with `max_summary_addition_lines`.

**Failure action:** Reject the oversized patch; log `COGNITION_SIZE_GUARD`; apply remaining patches.

### 6.4 Confidence Threshold

**Rule:** `result.confidence` must be ≥ `constraints.require_confidence_threshold`.

**Failure action:** Reject the entire result if below threshold; archive notes as `rejected`; log `COGNITION_LOW_CONFIDENCE`.

### 6.5 Apply Semantics

When all checks pass, the foreman:
1. Writes proposed content to the target files (overwriting — the librarian produces full content).
2. Moves all `archive_actions` from pending to archive.
3. Updates `cognition-index.json`.
4. Commits the changed cognition files as part of the delivery commit.

---

## 7. Multi-Agent Readiness

This model is provider-neutral by design:

- The librarian role is defined by its packet/result contract, not by any provider feature.
- The foreman needs only: packet accepted → result returned → result validated.
- No heartbeat or verbose progress chatter is required from the librarian; the sealed result file is the sole output contract.
- Any provider (Claude, Gemini, Copilot, Windsurf) that can read a JSON packet, produce a JSON result, and write to a file path can serve as the cognition librarian.

**Dispatch mode:** The foreman dispatches the librarian using the same `dispatch_mode` as workers. The librarian uses `role: "cognition-librarian"` in its packet.

---

## 8. Migration from Direct Mutation

Workers currently write cognition updates directly to `POLARIS.md` / `SUMMARY.md` via the Route Cognition Delta section of their packet.

**Transition policy:**
1. This spec takes effect on first use of `.polaris/cognition/pending/`.
2. During the transition, the Route Cognition Delta direct-write behavior remains valid but is deprecated for new children once POL-250 is implemented.
3. Direct writes are phased out after POL-254 (foreman dispatch) is operational.
4. No migration of existing `POLARIS.md` / `SUMMARY.md` content is required — the librarian reconciles forward, not backward.

---

## 9. Implementation Plan (Ordered Children)

Children MUST be executed in dependency order:

| Child | Title | Depends On |
|---|---|---|
| POL-250 | Create `.polaris/cognition/` staging folder structure and POLARIS.md contract | — |
| POL-251 | Define worker note schema and update worker packet to require note writing | POL-250 |
| POL-252 | Extend CompactReturn to include `work_note_path` and validate note presence | POL-251 |
| POL-253 | Create cognition-librarian role file and define packet/result contract types | POL-250 |
| POL-254 | Implement foreman cognition-librarian dispatch and patch validation | POL-253, POL-252 |
| POL-255 | Archive model, cognition-index, and provenance records for reconciled notes | POL-254 |

---

## 10. Related Specs

- `foreman-worker-architecture.md` — Foreman and worker roles, dispatch modes
- `worker-session-contract.md` — Worker session identity fields
- `worker-telemetry-spec.md` — Heartbeat and event schema definitions
- `polaris-artifact-promotion-commit-hygiene-policy.md` — Commit staging allowlist
- POL-233 analysis: `smartdocs/raw/pol-233-smartdocs-normalize-routing-cognition-analysis.md`
- POL-240 analysis: `smartdocs/raw/pol-240-artifact-promotion-commit-hygiene.md`
