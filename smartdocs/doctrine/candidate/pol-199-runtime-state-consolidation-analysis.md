---
status: candidate
candidate-since: 2026-05-29
source: smartdocs/docs/raw/pol-199-runtime-state-consolidation-analysis.md
doc-type: doctrine-candidate
confidence: 0.0
recommended-action: hold
overlap-analysis: pending
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-05-29-001
classified-as: doctrine-candidate
linked-map-area: src/finalize
ingested-at: 2026-05-29T04:47:58.189Z
---

# POL-199 Runtime State Consolidation Analysis

Analysis source: POL-199 — ANALYZE: Runtime state consolidation, cluster-state design, and repository cognition coverage

Run id: `polaris-analyze-issue-orientation-2026-05-29-001`

## Decision

POL-199 is executable and should be decomposed into an IMPLEMENT parent with ordered children. The repository already has the pieces of the intended model, but live execution truth is split across multiple mutable state surfaces.

The safest target model is:

- `clusters.json` remains imported/planned work graph truth.
- `cluster-state.json` becomes live per-cluster execution truth.
- `packets/` and `results/` become sealed cluster-local handoff artifacts.
- `.polaris/runs/ledger.jsonl` remains the committed cross-agent run index.
- telemetry remains append-only debug/audit output during migration, not resume truth.
- `.taskchain_artifacts/` remains compatibility/debug output until every reader/writer is migrated.

## Current-State Inventory

| Path / Surface | Current role | Classification | Readers / writers observed |
|---|---|---|---|
| `.taskchain_artifacts/polaris-run/current-state.json` | Active run state for current Polaris run | canonical during migration | `src/loop/checkpoint.ts`, `src/loop/continue.ts`, `src/loop/parent.ts`, `src/loop/worker.ts`, `src/mcp/tools/*`, `src/finalize/*`, `src/runtime/continuation/*`, `src/runs/reconcile.ts` |
| `.taskchain_artifacts/bootstrap-run/current-state.json` | Legacy/default bootstrap-run state path | legacy/transitional | `src/loop/continue.ts`, MCP loop tools, continuation runtime |
| `.taskchain_artifacts/*/runs/<run-id>/telemetry.jsonl` | Append-only lifecycle/debug events | debug/audit, not resume truth | loop checkpoint/continue/parent/worker, MCP claim/result tools, docs ingest, doctrine lifecycle |
| `.polaris/runs/ledger.jsonl` | Committed global resume index | canonical cross-agent index | `src/loop/ledger.ts`, parent/continue flow, `src/runs/index.ts` |
| `.polaris/runs/current-state.json` | Duplicate active run snapshot observed in repo | transitional/derived | used by tests and recent run artifacts; overlaps `.taskchain_artifacts/polaris-run/current-state.json` |
| `.polaris/runs/<run-id>/` | Final archived run snapshot and report | canonical archive after finalize | `src/finalize/steps/12-archive.ts` |
| `.polaris/bootstrap/*.json` | Bootstrap packets emitted at checkpoint/handoff | derived sealed handoff | `src/loop/bootstrap-packet.ts`, `src/loop/continue.ts`, resume/status tests |
| `.polaris/clusters/<id>/clusters.json` | Imported/planned work graph | canonical graph/import truth | `src/tracker/local-graph.ts`, `src/tracker/adapters/linear/index.ts`, `src/cli/tracker.ts`, finalize reconciliation |
| `.polaris/runs/mutation-queue.json` | Tracker sync-out mutation queue | canonical queue when mcp-bridge reconciliation is used | `src/tracker/sync/queue-store.ts`, `src/tracker/sync/index.ts` |
| `.polaris/map/*` | Route map and review artifacts | derived repo cognition index | map/finalize flows, archived by finalize |
| `POLARIS.md` / `SUMMARY.md` under `.polaris/*` | Missing today | missing cognition coverage | issue asks to introduce folder-level coverage |

## Risks

Removing `.taskchain_artifacts/` immediately would break active loop, worker, MCP, finalize, docs-ingest, and tool status paths. It should first become a compatibility mirror or debug-only output after `cluster-state.json` is authoritative.

Deprecating telemetry immediately would remove boundary and failure evidence used by dispatch enforcement, canon checks, docs ingest, and tool diagnostics. Telemetry can stop being resume truth now, but it should remain append-only audit output until the ledger and cluster-state cover every resume decision.

Replacing `current-state.json` directly would break validation, bootstrap packet generation, worker completion, MCP claim/result operations, and finalize schema validation. A staged adapter is required: add `cluster-state.json`, dual-read or mirror, then migrate writers, then remove direct current-state dependence.

Mutating `clusters.json` for claims would create drift from tracker/import truth. It should answer "what work exists"; it should not answer "who owns this child right now."

## Proposed Runtime State Model

`clusters.json` owns:

- imported Linear/project graph identity,
- issue title/status/session metadata,
- child ordering and dependencies,
- tracker source metadata,
- analysis traceability.

`cluster-state.json` owns:

- active run id and cluster id,
- live child states: `ready`, `claimed`, `dispatched`, `running`, `done`, `failed`, `blocked`, `reviewed`, `finalized`,
- claim/lease metadata and worker id,
- packet and result file pointers,
- validation summary and commit hash,
- blocker/failure records,
- next runnable child,
- idempotency keys for tracker mutations,
- timestamps and schema version.

`packets/` owns immutable dispatch packets. `results/` owns immutable worker result files. Workers receive one packet and one result path. Workers must not write `cluster-state.json` directly; they write sealed result files. The Polaris runtime validates results and updates cluster state atomically.

Run-level state belongs in `.polaris/runs/ledger.jsonl` and `.polaris/runs/<run-id>/` archives. The ledger is the committed cross-agent index. Per-cluster state is not a replacement for the ledger; it is the live execution authority for one cluster.

## Foreman Selection Model

The foreman loads `.polaris/clusters/<cluster-id>/clusters.json` and `.polaris/clusters/<cluster-id>/cluster-state.json`.

Selection rules:

1. Exclude children already `done`, `failed`, `blocked`, or `finalized`.
2. Exclude children whose dependencies are not `done`.
3. Exclude children with an unexpired `claimed` or `running` lease.
4. Select the lowest ordered runnable child.
5. Atomically transition `ready -> claimed -> dispatched`.
6. Write a sealed packet under `packets/`.
7. Accept only a sealed result whose child id, claim id, packet id, and state generation match.

Duplicate dispatch is prevented by an atomic state generation or compare-and-swap write. A second foreman cannot claim the same child unless the prior claim expires or is explicitly released.

Concurrent clusters are safe because each cluster has its own directory and `cluster-state.json`. Shared ledgers and mutation queues still need append/queue locking.

## Tracker Reconciliation Model

Linear sync-in should continue to refresh `clusters.json`. Sync-out should not mark Linear children Done before the worker result is validated and the cluster-state transition succeeds.

Recommended phases:

- On child result accepted: queue a tracker mutation with idempotency key and desired status/comment.
- On validation/review/finalize boundary: apply queued mutations through the configured bridge.
- On conflict: mark mutation `conflicted`, keep cluster-state unchanged or `needs-reconcile`, and halt with a clear operator action.
- On retry: reuse the same idempotency key.

Direct Linear adapter remains sync-in only unless it is intentionally upgraded. `mcp-bridge` remains the two-way reconciliation path.

## Repository Cognition Coverage

Always create and maintain cognition surfaces for:

- `.polaris/POLARIS.md` and `.polaris/SUMMARY.md`
- `.polaris/clusters/POLARIS.md` and `.polaris/clusters/SUMMARY.md`
- `.polaris/runs/POLARIS.md` and `.polaris/runs/SUMMARY.md`
- `.polaris/bootstrap/POLARIS.md` and `.polaris/bootstrap/SUMMARY.md`
- `.polaris/map/POLARIS.md` and `.polaris/map/SUMMARY.md`

Do not create `POLARIS.md` / `SUMMARY.md` inside every individual run or cluster directory by default. Use adaptive cognition only when a subdirectory becomes a stable source-owned subsystem rather than generated runtime output.

The Librarian should maintain folder cognition after runs when operational behavior changes, and should keep `.taskchain_artifacts/` documented as generated/compatibility artifacts rather than source-owned canon.

## Implementation Plan

Cluster 01 is a sequential implementation cluster. Each child depends on the prior child unless stated otherwise.

1. Write the canonical runtime-state spec and migration inventory.
2. Add `cluster-state.json` schema, state store, fixtures, and validation.
3. Teach bootstrap/foreman selection to initialize and use cluster state while preserving compatibility with current-state.
4. Add sealed packet/result folders and migrate claim/result updates away from worker direct state writes.
5. Add tracker reconciliation queue semantics tied to cluster-state transitions.
6. Add Polaris-owned folder cognition files and validation coverage.
7. Add staged deprecation guards, docs, and validation for `.taskchain_artifacts`/telemetry/current-state compatibility.

## Validation Commands

Implementation children should use focused validation first:

```bash
npm run build
npx vitest run src/loop src/tracker src/mcp src/finalize src/cognition
npm run polaris -- map validate
git diff --check
```

Broader validation can be added by the child that changes shared runtime contracts.
