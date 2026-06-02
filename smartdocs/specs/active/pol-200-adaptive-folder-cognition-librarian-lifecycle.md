---
kind: analysis
status: active
source: POL-200
created: 2026-06-02
run_id: polaris-analyze-adaptive-folder-cognition-librarian-2026-06-02-001
related:
  - folder-cognition-staging-librarian.md
  - foreman-worker-architecture.md
  - worker-session-contract.md
depends_on:
  - src/cognition/librarian-dispatch.ts
  - src/cognition/librarian-types.ts
  - src/cognition/route-cognition-delta.ts
  - src/loop/compact-return.ts
  - src/loop/continue.ts
  - src/loop/lifecycle-dispatch.ts
  - .polaris/roles/librarian.md
  - smartdocs/specs/active/folder-cognition-staging-librarian.md
---

# POL-200 Analysis: Adaptive Folder Cognition and Librarian Role Lifecycle

**Issue:** POL-200
**Status:** Active analysis artifact
**Created:** 2026-06-02

---

## 1. Intended Librarian Architecture

### 1.1 Two Distinct Librarian Roles

Polaris has two named librarian concepts that must remain distinct:

| Role | Purpose | Scope | Defines |
|---|---|---|---|
| **SmartDocs Librarian** | Promotes docs through ingest pipeline (raw → candidate → active → doctrine) | `smartdocs/` tree only | `.polaris/roles/librarian.md` (current) |
| **Cognition Librarian** | Reconciles worker work notes into durable folder cognition (`POLARIS.md` / `SUMMARY.md`) | `.polaris/cognition/` staging + repo folder surfaces | Types: `librarian-types.ts`; Dispatch: `librarian-dispatch.ts` |

The SmartDocs Librarian may NOT dispatch. The Cognition Librarian is dispatched by the foreman and returns a sealed result — it never writes directly.

### 1.2 Cognition Librarian Design

The Cognition Librarian is a **provider-neutral role** defined by a packet/result contract:

- **Input (packet):** folder, note_paths, polaris_md_path, summary_md_path, constraints
- **Output (result):** proposed_patches (full proposed content, not diffs), archive_actions, confidence score
- **Invariant:** librarian NEVER writes to `POLARIS.md` or `SUMMARY.md` directly; the foreman applies patches after validation

The foreman enforces five validation rules before applying any patch (from spec §6):
1. Schema validity — reject entire result on failure
2. Confidence threshold (≥0.80) — reject entire result below threshold
3. File scope check — reject entire result if any patch targets a file outside allowed_files
4. Doctrine bleed check — reject per-patch if SUMMARY.md contains operational imperatives
5. Size guard — reject per-patch if proposed content exceeds line limits

### 1.3 Adaptive Folder Coverage Policy (Architecture Recommendation)

The current `isCognitionSkippedFolder()` is **reactive**: it decides whether to skip a folder when a change has already been detected. There is no **proactive** policy defining which folders should receive `POLARIS.md` / `SUMMARY.md` at all.

Recommended coverage policy (three tiers):

**Tier 1 — Polaris-owned folders (always get cognition):**
These folders always receive `POLARIS.md` because Polaris commits to maintaining them:
- `.polaris/` root
- `src/` (each immediate subdirectory)
- `smartdocs/specs/active/`
- `smartdocs/doctrine/active/` (when it exists)

**Tier 2 — Adaptive signals for arbitrary repo folders:**
Create or update `POLARIS.md` only when ALL of:
1. The folder contains ≥1 non-test, non-generated source file
2. A worker touched a file in that folder with an operational signal (`detectOperationalReasons()` returns non-empty)
3. The folder is not in the `isCognitionSkippedFolder()` exclusion list

**Tier 3 — User-protected surfaces:**
`POLARIS.md` or `SUMMARY.md` files that existed BEFORE Polaris was initialized are user-created. They must NEVER be overwritten without explicit operator approval. Identification: compare file mtime with Polaris initialization date, OR use a manifest of Polaris-managed surfaces.

**Coverage floor:** Never create cognition in folders containing only test files (`*.test.ts`), generated files (`dist/`, `*.d.ts`), or hidden config (`.git/`).

### 1.4 `POLARIS.md` vs `SUMMARY.md` Contracts

**`POLARIS.md` contract:**
- Operational guidance for agents working in that folder
- Contents: folder purpose, what belongs here, editing rules, route model, related routes
- Owner: Polaris (may be co-authored by user if user created it first)
- Update trigger: folder responsibilities, commands/workflows, execution constraints, ownership/routing, or operational behavior changed
- Size constraint: additions ≤20 net new lines per reconciliation cycle

**`SUMMARY.md` contract:**
- Current-state compression for context efficiency
- Contents: linked docs/specs, canon relationships, architecture meaning
- NOT a changelog; the librarian synthesizes or replaces stale content
- Update trigger: linked docs changed significantly, canon relationships changed, architecture meaning changed
- Size constraint: ≤`SUMMARY_MAX_BYTES` bytes (defined in `summary-delta.ts`)

### 1.5 Lifecycle Placement

Cognition librarian dispatch should run **after each child completes, before the next child is dispatched** — not in batch at finalize. This keeps cognition current and avoids a large, failure-prone batch reconciliation at the end of a cluster.

Recommended placement in `loop continue`:

```
loop continue (foreman):
  1. Verify completion evidence for completed child
  2. Bridge evidence to cluster-state
  3. Write updated loop state
  4. [NEW] Collect work_note_paths from CompactReturn
  5. [NEW] Call dispatchCognitionLibrarian(work_note_paths, ...)
     - Group notes by folder
     - Dispatch librarian per folder (non-blocking — failure does not halt cluster)
     - Validate + apply patches
     - Archive notes
  6. Canon check for next child
  7. Generate bootstrap packet for next child
```

Librarian failure is NON-BLOCKING: a cognition reconciliation failure should log telemetry and continue to the next child. It must never halt cluster execution.

---

## 2. Current Implementation State

### 2.1 Fully Implemented

| Component | Location | Status |
|---|---|---|
| Cognition librarian type system | `src/cognition/librarian-types.ts` | ✅ Complete — packet, result, constraints, archive action, validation outcome, schema validator |
| `dispatchCognitionLibrarian()` | `src/cognition/librarian-dispatch.ts` | ✅ Complete — groups notes by folder, dispatches per folder, polls for result, calls validate |
| `validateAndApplyLibrarianResult()` | `src/cognition/librarian-dispatch.ts` | ✅ Complete — enforces all 5 validation rules from spec §6 |
| Cognition archive model | `src/cognition/archive.ts` | ✅ Complete — note movement, `cognition-index.json` provenance |
| Route cognition delta | `src/cognition/route-cognition-delta.ts` | ✅ Complete — `isCognitionSkippedFolder()`, `detectOperationalReasons()`, `applyRouteCognitionDelta()`, `findNearestRoutePolarismd()` |
| Summary delta | `src/cognition/summary-delta.ts` | ✅ Complete — `applySummaryDelta()`, `hasDoctrineBled()`, `isSummaryOversized()`, `SUMMARY_MAX_BYTES` |
| Cognition validation | `src/cognition/validate.ts` | ✅ Complete — `validateCognitionSurfaces()`, violation types |
| Public API re-exports | `src/cognition/index.ts` | ✅ Complete — all exports present |
| `librarian` role in worker packet | `src/loop/worker-packet.ts` | ✅ Present — role type includes `'librarian'` |
| `librarian` role routing in dispatch | `src/loop/dispatch.ts` | ✅ Present — routes to `documentation` session type |
| Archive processing in lifecycle | `src/loop/lifecycle-dispatch.ts` | ✅ Partial — `archiveCognitionNotes` called when finalize result contains `cognition_archive` field |
| Spec document | `smartdocs/specs/active/folder-cognition-staging-librarian.md` | ✅ Authoritative — covers worker note contract, librarian packet/result, validation rules, archive model, implementation plan |

### 2.2 Specified Only — Not Yet Implemented

**Note on POL-249 cluster delivery status:** POL-249 and its children (POL-250–255) are marked Done in Linear. However, git forensics reveal that several child commits were empty or partial. Specifically, POL-254 committed `librarian-dispatch.ts` and `librarian-types.ts` (real code), but did NOT wire `dispatchCognitionLibrarian` into `loop/continue.ts`. POL-252's commit was empty — `CompactReturn` was never extended. POL-251's commit did not modify `worker.ts`. The dispatch module exists; the integration plumbing does not.

| Component | Expected Location | Tracker Status | Actual Status |
|---|---|---|---|
| `.polaris/cognition/` staging directory structure | `.polaris/cognition/pending/`, `.polaris/cognition/archive/` | POL-250 Done | ❌ Directory does not exist |
| `.polaris/cognition/POLARIS.md` contract file | `.polaris/cognition/POLARIS.md` | POL-250 Done | ❌ File does not exist |
| Cognition-librarian role file | `.polaris/roles/cognition-librarian.md` | POL-253 Done | ❌ Only SmartDocs librarian is defined in `.polaris/roles/librarian.md` |
| Worker cognition note writing | `src/loop/worker.ts` (new step before CompactReturn) | POL-251 Done | ❌ Workers use direct-write pattern only (`applyRouteCognitionDelta`) |
| `work_note_paths` in CompactReturn | `src/loop/compact-return.ts` | POL-252 Done | ❌ Field absent; POL-252 commit was empty |
| Foreman dispatch of cognition librarian | `src/loop/continue.ts` | POL-254 Done | ❌ Module exists; `dispatchCognitionLibrarian` never called from loop |
| Adaptive coverage policy implementation | `src/cognition/route-cognition-delta.ts` (or new module) | Not tracked | ❌ Only reactive skip rules exist |

### 2.3 Partially Wired

| Component | What's Present | What's Missing |
|---|---|---|
| `lifecycle-dispatch.ts` cognition handling | `archiveCognitionNotes()` called when finalize result contains `cognition_archive` | Dedicated cognition-librarian dispatch is not called; archive only happens if lifecycle agent embeds the data in its result |
| Worker cognition delta | `worker.ts` calls `applyRouteCognitionDelta()` + `applySummaryDelta()` | These write directly to POLARIS.md/SUMMARY.md — the old pattern. Not transitioning to staged notes yet. |
| `dispatchCognitionLibrarian` | Fully implemented, exported from `src/cognition/index.ts` | Never imported or called by any loop module |

---

## 3. Gap Analysis

| Gap | Severity | Phase Blocking | Spec Reference |
|---|---|---|---|
| `.polaris/cognition/` staging dir absent | HIGH | YES — notes cannot be written | spec §1.1 / POL-250 |
| Workers do not write pending notes | HIGH | YES — librarian has nothing to process | spec §2.1 / POL-251 |
| `CompactReturn` missing `work_note_paths` | HIGH | YES — foreman cannot collect note paths | spec §2 / POL-252 |
| `loop continue` never dispatches librarian | HIGH | YES — `dispatchCognitionLibrarian` unreachable from run loop | spec §3 / POL-254 |
| `.polaris/roles/librarian.md` is SmartDocs-only | MEDIUM | NO — types exist in code | POL-253 |
| No cognition-librarian role file | MEDIUM | NO — but confusing for agents | POL-253 |
| Adaptive coverage policy is undefined | MEDIUM | NO — reactive skip rules exist | POL-200 (new work) |
| User-protection rules not enforced | MEDIUM | NO — no Polaris-created surface manifest | POL-200 (new work) |
| No `.polaris/cognition/POLARIS.md` contract | LOW | NO — workers can still write notes | POL-250 |

### 3.1 Root Cause vs. Symptom

The absence of `.polaris/cognition/` is a **symptom** — the root cause is that the implementation cluster (POL-249 children) has not yet been executed. The types and dispatch logic are ready; the wiring steps and infrastructure creation are the gap.

### 3.2 Missing Integration Points (Ordered by Dependency)

1. **Worker → staging** (`src/loop/worker.ts`): Before emitting CompactReturn, worker must write a `.md` note to `.polaris/cognition/pending/<folder-slug>/`.
2. **CompactReturn extension** (`src/loop/compact-return.ts`): Add `work_note_paths?: string[]` field.
3. **loop continue wiring** (`src/loop/continue.ts`): After reading CompactReturn, collect `work_note_paths`; call `await dispatchCognitionLibrarian(...)` before generating next-child bootstrap packet.
4. **Staging dir init** (new setup step or POL-250): `.polaris/cognition/pending/` and `.polaris/cognition/archive/` must exist before first worker runs.
5. **Role file** (`.polaris/roles/`): Create `cognition-librarian.md` to distinguish this role from the SmartDocs librarian.

---

## 4. Recommended Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  Worker session (per child)                                     │
│                                                                 │
│  1. Execute implementation work                                 │
│  2. Run validation commands                                     │
│  3. Determine primary affected folder → folder_slug            │
│  4. Write work note                                             │
│     → .polaris/cognition/pending/<folder_slug>/                 │
│        <run-id>-<child-id>.md  (docs_impact field required)    │
│  5. Emit CompactReturn { work_note_paths: [...] }              │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  loop continue (foreman — after each child)                     │
│                                                                 │
│  1. Verify completion evidence                                  │
│  2. Bridge evidence to cluster-state                            │
│  3. Write updated loop state                                    │
│  4. [NEW] Collect work_note_paths from CompactReturn            │
│  5. [NEW] dispatchCognitionLibrarian(work_note_paths, ...)      │
│     ├─ group notes by folder_slug                               │
│     ├─ for each folder:                                         │
│     │   ├─ build CognitionLibrarianPacket                       │
│     │   ├─ dispatch librarian session                           │
│     │   ├─ wait for sealed result                               │
│     │   └─ validateAndApplyLibrarianResult(...)                 │
│     │       ├─ PASS: write patches, archive notes               │
│     │       └─ FAIL: log telemetry, continue (non-blocking)     │
│     └─ emit cognition-librarian telemetry events                │
│  6. Canon check for next child                                  │
│  7. Generate bootstrap packet for next child                    │
└─────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Finalize (lifecycle phase)                                     │
│                                                                 │
│  Existing lifecycle-dispatch cognition_archive handling         │
│  covers any residual notes not reconciled per-child.            │
│  (Already partially wired.)                                     │
└─────────────────────────────────────────────────────────────────┘
```

**Dispatch timing:** After each child — not batched at finalize. Rationale: keeps cognition current; avoids a single large librarian batch that could fail and leave all notes unreconciled.

**Non-blocking invariant:** A cognition librarian failure must never halt the cluster. Log the failure in telemetry, archive notes as `rejected` in `cognition-index.json`, and continue.

**SmartDocs Librarian remains separate:** It runs via `docs-ingest` / `docs-promote` commands and operates only within `smartdocs/`. It is never dispatched by the foreman.

---

## 5. Recommended Implementation Sequence

The POL-249 cluster already defines children POL-250 through POL-255. This analysis confirms that sequence is correct and adds two new work items for the adaptive coverage and user-protection gaps identified by POL-200.

### 5.1 POL-249 Cluster (Existing, Not Yet Executed)

| Child | Title | Depends On | Status |
|---|---|---|---|
| POL-250 | Create `.polaris/cognition/` staging folder structure and POLARIS.md contract | — | Todo |
| POL-251 | Define worker note schema and update worker packet to require note writing | POL-250 | Todo |
| POL-252 | Extend CompactReturn to include `work_note_paths` and validate note presence | POL-251 | Todo |
| POL-253 | Create cognition-librarian role file and define packet/result contract types | POL-250 | Todo |
| POL-254 | Implement foreman cognition-librarian dispatch and patch validation in `loop continue` | POL-253, POL-252 | Todo |
| POL-255 | Archive model, cognition-index, and provenance records for reconciled notes | POL-254 | Todo |

### 5.2 New Work Items (From This Analysis)

| Item | Title | Depends On | Priority |
|---|---|---|---|
| NEW-A | Define and implement adaptive folder coverage policy (positive coverage tiers + coverage floor) | POL-255 | High |
| NEW-B | Implement user-created surface protection (manifest + mutation guard) | POL-255 | High |
| NEW-C | Update `.polaris/roles/librarian.md` to distinguish SmartDocs vs. Cognition librarian | POL-253 | Medium |

**NEW-A** and **NEW-B** should be added as children of the POL-249 cluster or as a follow-on cluster created after POL-255. They are NOT blockers for POL-250–255 execution.

### 5.3 Gitignore Policy

From spec §1.4:
```gitignore
# Cognition staging — ephemeral, not committed
.polaris/cognition/pending/

# Cognition archive — durable provenance, committed
# (archive/ is tracked by default — no ignore entry needed)
```

This policy must be applied in POL-250.

---

## 6. Risks of Executing POL-161 or POL-171 Before Librarian Alignment

### 6.1 POL-161: Parallel Smart Docs Bootstrap

**What POL-161 does:** Adds distributed markdown bootstrap mode — workers enumerate files, partition into batches, produce intermediate artifacts, parent merges into unified Smart Docs state.

**Risk:** MEDIUM

- POL-161 workers run under the current direct-write pattern (`applyRouteCognitionDelta`, `applySummaryDelta`). With distributed workers touching many folders simultaneously, cognition files could be created in many places without a review layer.
- The distributed bootstrap will likely trigger `detectMissingSummaries()` across many folders — creating many new `POLARIS.md` / `SUMMARY.md` files without librarian vetting.
- These files are valid but unreviewed. When the librarian dispatch is added later, the librarian would need to reconcile against this pre-existing content.
- **Specific concern:** If workers write conflicting cognition to the same folder (multiple workers touching `src/loop/` simultaneously), the last writer wins — no merge or review.
- **Mitigation:** Proceed with POL-161, but after POL-255 is complete, run a one-time cognition reconciliation pass over all folders touched by POL-161 workers. Document this debt.

### 6.2 POL-171: Polaris Map Lifecycle and Pruning

**What POL-171 does:** Adds route lifecycle states, stale detection, pruning, tombstone archival, `polaris map prune`, `polaris map reconcile`, multi-agent consistency safeguards.

**Risk:** MEDIUM-HIGH

- POL-171's pruning operation will **tombstone routes** — routes for deleted or restructured files are archived. This can create **orphaned cognition surfaces**: a `POLARIS.md` exists for a folder whose routes were tombstoned.
- Without the cognition librarian, there is no automated process to detect and clean up orphaned surfaces. An agent navigating a tombstoned route's `POLARIS.md` may receive stale guidance.
- **Specific concern:** `.polaris/map/` folder cognition references file routes. If POL-171 tombstones entries from `file-routes.json`, the `POLARIS.md` for `src/map/` may reference behaviors that no longer exist.
- `detectOperationalReasons()` marks `src/map/` changes as `ownership-routing-changed`, triggering cognition update — but through the old direct-write pattern, not through review.
- **Mitigation:** Before executing POL-171, audit `.polaris/map/POLARIS.md` and `src/map/POLARIS.md` for content that references routes. After POL-171, run a manual review of any folder whose routes changed. After POL-255, the librarian can handle future pruning events automatically.

### 6.3 Shared Risk: Accumulated Unreviewed Direct-Write Cognition

Both POL-161 and POL-171 will accumulate direct-write cognition files. Once POL-254 lands (librarian dispatch), any further child execution will go through the staged/reviewed path. However, the pre-existing direct-written content is not automatically re-reconciled.

**Recommended practice:**
- Proceed with POL-161 and POL-171 with awareness of this debt.
- After POL-255 is complete, create a one-time "cognition retroactive reconciliation" run: populate `.polaris/cognition/pending/` with synthetic work notes covering folders changed by POL-161 and POL-171, then dispatch the librarian.
- Do NOT defer POL-161 or POL-171 solely for librarian alignment — the risk is manageable with the retroactive reconciliation step.

---

## 7. Verification Checklist

- [x] Analysis defines adaptive folder cognition coverage (§1.3)
- [x] Required Polaris-owned folder doctrine and summaries identified (§1.3, Tier 1)
- [x] User-created POLARIS.md and SUMMARY.md protection rules defined (§1.3, Tier 3)
- [x] Librarian role defined as configurable and first-class (§1.1, §1.2)
- [x] Librarian dispatch before/during finalization specified (§1.5, §4)
- [x] Resulting repo-cognition workflow is scoped and low-noise (§1.3 coverage policy, §1.2 invariants)
- [x] All required integration points identified (§3.2)
- [x] SmartDocs Librarian vs. Cognition Librarian distinction (§1.1)
- [x] Current-state audit and implementation gap assessment (§2)
- [x] Implementation cluster recommendation included (§5)
- [x] Risks of POL-161 and POL-171 execution assessed (§6)
- [x] Proposed workflow does NOT require cognition files in every repo folder (§1.3 — Tier 2 adaptive signals, Tier 3 user protection)
- [x] Implemented vs. specified behavior clearly separated (§2)

---

## 8. Summary

The Cognition Librarian is **architecturally complete** in terms of types and dispatch logic, but **entirely unwired** in the active run loop. Workers still use the deprecated direct-write pattern. The four highest-priority gaps are:

1. `.polaris/cognition/` directory doesn't exist
2. Workers don't write staged notes
3. `CompactReturn` lacks `work_note_paths`
4. `loop continue` never calls `dispatchCognitionLibrarian`

These are the exact gaps addressed by POL-250 through POL-254. This analysis confirms that POL-249 cluster execution should proceed in the defined order. Two new items (adaptive coverage policy, user-protection guard) should follow POL-255.

POL-161 and POL-171 may proceed concurrently with librarian wiring — the risk is accumulated unreviewed direct-write cognition, addressable by a retroactive reconciliation pass after POL-255 completes.
