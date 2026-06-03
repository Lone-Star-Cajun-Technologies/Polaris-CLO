---
kind: spec
status: active
source: closeout-librarian-runtime
created: 2026-06-03
depends_on:
  - foreman-worker-architecture.md
  - folder-cognition-staging-librarian.md
  - worker-session-contract.md
source_paths:
  - .polaris/roles/closeout-librarian.md
  - .polaris/skills/closeout-librarian/
  - src/cognition/closeout-librarian-types.ts
  - .polaris/skills/polaris-run/steps/08-closeout-librarian.md
  - .polaris/skills/polaris-run/steps/09-final-delivery.md
---

# Closeout Librarian Architecture Spec

**Status:** Authoritative spec
**Created:** 2026-06-03

---

## 1. Overview

The Closeout Librarian is a bounded runtime role that reconciles completed cluster work
into project cognition. It runs exactly once per completed cluster, after all children are
done and before PR creation. PR creation is blocked until the Librarian result is validated.

### 1.1 Role Boundaries

| Role | Implementation | Orchestration | Documentation |
|------|---------------|---------------|---------------|
| Worker | Yes | No | Cognition notes only |
| Foreman | No | Yes | No |
| Cognition Librarian | No | No | Folder-local per-worker |
| **Closeout Librarian** | No | No | **Cluster-wide, once per cluster** |

The Closeout Librarian is distinct from:
- **Workers**: Closeout Librarian does not implement code.
- **Foreman**: Closeout Librarian does not orchestrate execution.
- **Cognition Librarian**: Cognition Librarian reconciles per-folder notes per worker.
  Closeout Librarian reconciles cluster-wide cognition once per cluster.

### 1.2 Execution Position

```
Cluster Complete
→ (Foreman confirms all children Done)
→ Generate Librarian Packet                  [npm run polaris -- librarian packet <id>]
→ Dispatch Closeout Librarian                [subagent session]
→ Librarian runs steps 01–08
→ Librarian writes sealed result
→ Librarian makes librarian commit
→ Foreman validates result
→ (success or partial) → polaris finalize
→ PR Created
→ Complete
```

---

## 2. Triggering Conditions

The Closeout Librarian is triggered by the Foreman at exactly one point:

**After `cluster-complete` AND before `polaris finalize`.**

It is NOT triggered:
- After individual worker completions
- During dispatch/continue cycles
- During analysis (polaris-analyze)
- During re-dispatch (replacement worker for failed child)

One Librarian per cluster. If the Librarian fails and is re-dispatched, it replaces the
prior attempt — the per-cluster invariant holds.

---

## 3. Packet Schema

### 3.1 Packet Generation

The Foreman generates the Librarian packet via:
```bash
npm run polaris -- librarian packet <cluster-id>
```

The packet is written to:
```
.polaris/clusters/<cluster-id>/librarian-packet-<dispatch-id>.json
```

### 3.2 Packet Fields

See `src/cognition/closeout-librarian-types.ts` for the TypeScript interface
`CloseoutLibrarianPacket`.

Required fields:
| Field | Type | Description |
|---|---|---|
| `schema_version` | `"1.0"` | Schema version for forward compatibility |
| `role` | `"closeout-librarian"` | Role identity — validated by SKILL.md |
| `run_id` | string | Active run ID |
| `dispatch_id` | string | Unique ID for this dispatch event |
| `cluster_id` | string | Parent cluster ID |
| `completed_children` | string[] | Ordered list of completed child IDs |
| `child_summaries` | ChildSummary[] | Per-child metadata |
| `affected_folders` | string[] | Folders touched by this cluster |
| `polaris_md_paths` | FolderCognitionPaths[] | Per-folder cognition file paths |
| `cognition_notes` | string[] | Pending worker cognition note paths |
| `result_path` | string | Where the Librarian writes its sealed result |
| `prohibited_write_paths` | string[] | Must not write to these paths |
| `allowed_write_paths` | string[] | May only write to these paths |

### 3.3 Prohibited Write Paths

The following are ALWAYS in `prohibited_write_paths`:
- `.taskchain_artifacts/polaris-run/current-state.json`
- `.polaris/clusters/*/cluster-state.json`
- `.polaris/runs/ledger.jsonl`
- `.taskchain_artifacts/polaris-run/runs/*/telemetry.jsonl`
- All `src/**` paths (source code)
- All `*.ts`, `*.js` paths outside `smartdocs/`
- `.polaris/clusters/*/clusters.json`

### 3.4 Allowed Write Paths

The following are ALWAYS in `allowed_write_paths`:
- `**/POLARIS.md` (affected folders only)
- `**/SUMMARY.md` (affected folders only)
- `smartdocs/specs/active/*.md`
- `smartdocs/specs/active/*.provenance.json`
- `.polaris/cognition/archive/**`
- The `result_path`

---

## 4. Result Schema

See `src/cognition/closeout-librarian-types.ts` for `CloseoutLibrarianResult`.

### 4.1 Status Values

| Status | Meaning | Foreman Action |
|---|---|---|
| `"success"` | All work completed | Proceed to finalize |
| `"partial"` | Some work done, some blocked | Proceed to finalize; record partial |
| `"blocked"` | Significant blockers prevent work | Halt; escalate to operator |
| `"failure"` | Commit failed or packet invalid | Halt; escalate to operator |

### 4.2 Foreman Validation

Before proceeding to finalize, the Foreman validates:
1. `result.role === "closeout-librarian"`
2. `result.run_id` matches active run
3. `result.dispatch_id` matches the dispatch
4. `result.status` is `"success"` or `"partial"`
5. If `result.commit_sha` is non-null: verify commit is in git log
6. `result.files_committed` contains no path from `prohibited_write_paths`

Use `checkLibrarianResultGate(result)` from `closeout-librarian-types.ts`.

---

## 5. Librarian Mission Details

### 5.1 POLARIS.md Reconciliation

POLARIS.md files describe the current reality of each folder. The Librarian:
- Reads the current POLARIS.md for each affected folder
- Reads all child summaries and worker cognition notes
- Determines what has changed and whether POLARIS.md reflects that change
- Performs full reconciliation (not append-only notes)
- Writes the updated POLARIS.md with full content

Confidence threshold: `≥ 0.80` to apply. Below threshold → blocker, skip.

### 5.2 SUMMARY.md Reconciliation

SUMMARY.md files are continuation artifacts. The Librarian:
- Removes stale content contradicted by completed work
- Replaces superseded references with canonical ones
- Does NOT append history or changelog entries
- Produces a current-state snapshot usable by future sessions

### 5.3 Documentation Ingestion

The Librarian inspects documents in `smartdocs/raw/` that relate to completed work.
It may promote documents to `smartdocs/specs/active/` with correct frontmatter.
It may NOT promote to `smartdocs/doctrine/active/` (requires operator approval).
Doctrine candidates are recorded in the result for operator review.

### 5.4 Link Validation

Validates links in files written during this session only (not full repo scan).
Repairs broken links where target exists at a different path.
Records unrepairable links as informational blockers.

### 5.5 YAML Linking

Updates YAML frontmatter for promoted documents.
Updates SUMMARY.md references when documents are promoted from raw paths.
Updates `cognition-index.json` for folders with archived notes.

---

## 6. Commit Model

### 6.1 Librarian Commit

The Librarian creates exactly one commit containing:
- All POLARIS.md and SUMMARY.md updates
- All promoted/ingested documents
- All provenance files
- All archived cognition notes
- All YAML updates

This commit is separate from worker implementation commits. The git log will show:
```
<worker commit>   docs: implement POL-304: ...
<worker commit>   docs: implement POL-305: ...
<librarian commit> docs(closeout): reconcile cognition for cluster POL-303
```

### 6.2 No-Change Case

If everything was already current and no documentation changes were needed:
- `commit_sha: null` in result
- `files_committed: []`
- `status: "success"`

The Foreman accepts null commit SHA from the Librarian.

### 6.3 Commit Message Format

```
docs(closeout): reconcile cognition for cluster <cluster_id>

Run: <run_id>
Cluster: <cluster_id>
Children: <comma-separated child IDs>
Files updated:
- POLARIS.md: <n> files
- SUMMARY.md: <n> files
- docs ingested: <n>
- links repaired: <n>
```

---

## 7. Failure Handling

### 7.1 Recoverable Failures (continue to next step)

- One POLARIS.md update fails confidence threshold → skip, record as blocker, continue
- One link cannot be repaired → record as informational blocker, continue
- One document ingestion fails conflict check → record, do not ingest, continue

### 7.2 Fatal Failures (proceed to step 08 immediately)

- Packet unreadable or invalid → write failure result, terminate
- Commit fails → write failure result with commit error, terminate
- Result write fails → stderr only, terminate

### 7.3 Foreman Response to Failure

When Librarian status is `"blocked"` or `"failure"`:
1. Halt the finalize sequence.
2. Present the operator with:
   - Librarian status and evidence summary
   - All resolution-required blockers
   - Options: re-dispatch Librarian, skip Librarian (operator accepts degraded cognition), halt run
3. Wait for operator decision.
4. Do NOT automatically skip the Librarian.

---

## 8. Authority Boundaries

### 8.1 The Librarian May

- Update POLARIS.md files in affected folders
- Update SUMMARY.md files in affected folders
- Promote documents to `smartdocs/specs/active/`
- Archive documents in `smartdocs/raw/` (informational only)
- Archive worker cognition notes to `.polaris/cognition/archive/`
- Update `cognition-index.json` files
- Create `.provenance.json` files
- Commit documentation changes

### 8.2 The Librarian May Not

- Modify implementation source code
- Modify runtime state files
- Dispatch workers or sessions
- Create pull requests
- Update Linear issue status
- Promote to `smartdocs/doctrine/active/` (operator only)
- Modify cluster plan or clusters.json
- Change bootstrap seal or dispatch boundary state

---

## 9. Gap Analysis and Enforcement

### 9.1 Current Gaps

| Gap | Description | Impact | Classification |
|-----|-------------|--------|----------------|
| G1 | `npm run polaris -- librarian packet` CLI command not yet implemented | Foreman cannot generate Librarian packet automatically | Required during implementation |
| G2 | Finalize sequence does not have a pre-PR Librarian gate | Librarian can be skipped by calling finalize directly | Required during implementation |
| G3 | No Librarian dispatch boundary in dispatch-boundary.ts | Foreman could skip Librarian without runtime hard-fail | Required during implementation |
| G4 | Librarian commit not included in PR body by finalize | PR metadata incomplete | Required during implementation |
| G5 | No telemetry event for `librarian-dispatched` | Cannot track Librarian execution in run ledger | Required during implementation |

See `smartdocs/raw/closeout-librarian-gap-analysis.md` for the full gap analysis.

---

## 10. Related Specs

- `.polaris/roles/closeout-librarian.md` — Role definition and authority boundaries
- `.polaris/skills/closeout-librarian/` — Skill chain and steps
- `folder-cognition-staging-librarian.md` — Per-folder Cognition Librarian (separate role)
- `foreman-worker-architecture.md` — Dispatch model and Foreman doctrine
- `foreman-quiet-mode-spec.md` — Foreman quiet mode specification
- `worker-heartbeat-spec.md` — Worker heartbeat model specification
- `runtime-enforcement-spec.md` — Enforcement strategy
- `src/cognition/closeout-librarian-types.ts` — TypeScript types and validators
