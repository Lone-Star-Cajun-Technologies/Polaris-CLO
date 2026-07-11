---
title: Polaris Runtime State Consolidation Specification
status: draft
doc-type: architecture-spec
---

# Polaris Runtime State Consolidation Specification

This document codifies the target runtime-state model and migration inventory for the Polaris system, building upon the POL-199 analysis. Its objective is to establish a stable contract for subsequent implementation efforts, ensuring clarity regarding the responsibilities and interactions of various state surfaces.

## Target Runtime State Model

The safest target model for Polaris runtime state components is as follows:

-   `clusters.json`: Remains the authoritative source for the imported/planned work graph truth. It defines the issue hierarchy, relationships, and metadata derived from external trackers like Linear.
-   `cluster-state.json`: Becomes the live, per-cluster execution truth. This file captures the dynamic state of an active Polaris run, including the status of individual child issues within a cluster.
-   `packets/`: Designated for sealed, immutable dispatch packets. These artifacts represent the instructions given to a worker for a specific child issue.
-   `results/`: Designated for sealed, immutable worker result files. Workers will write their outcomes to these files, which are then validated by the Polaris runtime.
-   `.polaris/runs/ledger.jsonl`: Continues as the committed, cross-agent run index, providing a historical record of all Polaris runs.
-   Telemetry (`.taskchain_artifacts/*/runs/<run-id>/telemetry.jsonl`): Functions as append-only debug/audit output during the run. After finalize, the raw telemetry is promoted into `.polaris/runs/<run-id>/telemetry.jsonl` as durable archived routing evidence.
-   `.taskchain_artifacts/`: Acts as compatibility/debug output during the transitional phase until all readers/writers are migrated to the new canonical state models.

## Current-State Inventory and Migration Strategy

The following table provides an inventory of existing state surfaces and their planned roles during the migration to the new runtime state model.

| Path / Surface | Current Role | Classification (during migration) | Planned Role (Target Model) |
| :------------------------------------------ | :--------------------------------------------- | :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.taskchain_artifacts/polaris-run/current-state.json` | Active run state for current Polaris run | Canonical during migration | Compatibility mirror / Deprecated (after `cluster-state.json` becomes authoritative) |
| `.taskchain_artifacts/bootstrap-run/current-state.json` | Legacy/default bootstrap-run state path | Legacy/Transitional | Deprecated |
| `.taskchain_artifacts/*/runs/<run-id>/telemetry.jsonl` | Append-only lifecycle/debug events | Workspace scratch / Debug-Audit | Copied to `.polaris/runs/<run-id>/telemetry.jsonl` on finalize; workspace scratch may be pruned after archive |
| `.polaris/runs/ledger.jsonl` | Committed global resume index | Canonical cross-agent index | Canonical cross-agent index |
| `.polaris/runs/current-state.json` | Duplicate active run snapshot observed in repo | Transitional/Derived | Deprecated |
| `.polaris/runs/run-report.md` | Transient finalize report | Workspace scratch | Transient — archived snapshot lives under `.polaris/runs/<run-id>/run-report.md` |
| `.polaris/runs/<run-id>/` | Final archived run snapshot, report, and telemetry | Canonical archive after finalize | Canonical archive after finalize |
| `.polaris/bootstrap/*.json` | Bootstrap packets emitted at checkpoint/handoff | Derived sealed handoff | Derived sealed handoff |
| `.polaris/clusters/<id>/clusters.json` | Imported/planned work graph | Canonical graph/import truth | Canonical graph/import truth |
| `.polaris/runs/mutation-queue.json` | Tracker sync-out mutation queue | Canonical queue when mcp-bridge reconciliation is used | Canonical queue when mcp-bridge reconciliation is used |
| `.polaris/map/*` | Route map and review artifacts | Derived repo cognition index | Derived repo cognition index |
| `POLARIS.md` / `SUMMARY.md` under `.polaris/*` | Missing today | Missing cognition coverage | Canonical folder-level cognition files |

## Risks and Mitigation

*   **Immediate Removal of `.taskchain_artifacts/`:** Directly removing these artifacts would break existing functionalities across the Polaris ecosystem.
    *   **Mitigation:** `taskchain_artifacts/` will transition to a compatibility mirror or debug-only output *after* `cluster-state.json` achieves full authority.
*   **Immediate Deprecation of Telemetry:** This would eliminate critical boundary and failure evidence.
    *   **Mitigation:** Telemetry will cease to be resume truth but will remain as append-only audit output until `ledger.jsonl` and `cluster-state.json` fully cover all resume decisions.
*   **Direct Replacement of `current-state.json`:** This would disrupt existing validation, bootstrap packet generation, worker completion, and MCP operations.
    *   **Mitigation:** A staged adapter approach is required: introduce `cluster-state.json`, implement dual-read or mirroring, migrate writers, and then remove direct dependence on `current-state.json`.
*   **Mutating `clusters.json` for claims:** Using `clusters.json` to track claims would introduce drift from its role as the tracker/import truth.
    *   **Mitigation:** `clusters.json` will solely define the work that exists, not who currently owns a child.

## Proposed Component Responsibilities

### `clusters.json` Responsibilities

*   Imported Linear/project graph identity.
*   Issue title/status/session metadata.
*   Child ordering and dependencies.
*   Tracker source metadata.
*   Analysis traceability.

### `cluster-state.json` Responsibilities

*   Active run ID and cluster ID.
*   Live child states: `ready`, `claimed`, `dispatched`, `running`, `done`, `failed`, `blocked`, `reviewed`, `finalized`.
*   Claim/lease metadata and worker ID.
*   Packet and result file pointers.
*   Validation summary and commit hash.
*   Blocker/failure records.
*   Next runnable child.
*   Idempotency keys for tracker mutations.
*   Timestamps and schema version.

### `packets/` and `results/` Responsibilities

*   `packets/`: Stores immutable dispatch packets.
*   `results/`: Stores immutable worker result files.
*   Workers receive one packet and one result path and **must not** write to `cluster-state.json` directly; they write sealed result files.
*   The Polaris runtime is responsible for validating results and atomically updating `cluster-state.json`.

### Run-level State

*   Run-level state persists in `.polaris/runs/ledger.jsonl` (committed cross-agent index) and `.polaris/runs/<run-id>/` (final archived run snapshot).
*   Per-cluster state (`cluster-state.json`) is the live execution authority for a single cluster, not a replacement for the global ledger.

## Foreman Selection Model

The foreman loads `.polaris/clusters/<cluster-id>/clusters.json` and `.polaris/clusters/<cluster-id>/cluster-state.json` to make dispatch decisions.

Selection rules:

1.  Exclude children already `done`, `failed`, `blocked`, or `finalized`.
2.  Exclude children whose dependencies are not `done`.
3.  Exclude children with an unexpired `claimed` or `running` lease.
4.  Select the lowest ordered runnable child.
5.  Atomically transition `ready -> claimed -> dispatched`.
6.  Write a sealed packet under `packets/`.
7.  Accept only a sealed result whose child ID, claim ID, packet ID, and state generation match.

Duplicate dispatch is prevented by atomic state generation or compare-and-swap writes. Concurrent clusters are safe due to isolated directories and `cluster-state.json` instances. Shared ledgers and mutation queues require append/queue locking.

## Tracker Reconciliation Model

*   Linear sync-in continues to refresh `clusters.json`.
*   Sync-out will not mark Linear children `Done` until worker results are validated and `cluster-state.json` transitions successfully.

Recommended phases:

1.  **On child result accepted:** Queue a tracker mutation (with idempotency key and desired status/comment).
2.  **On validation/review/finalize boundary:** Apply queued mutations via the configured bridge.
3.  **On conflict:** Mark mutation `conflicted`, keep `cluster-state` unchanged or `needs-reconcile`, and halt with operator action.
4.  **On retry:** Reuse the same idempotency key.

`mcp-bridge` remains the primary two-way reconciliation path.

## Repository Cognition Coverage

Canonical cognition files (`POLARIS.md` and `SUMMARY.md`) will be maintained at the following `.polaris/*` levels:

*   `.polaris/POLARIS.md` and `.polaris/SUMMARY.md` (root level)
*   `.polaris/clusters/POLARIS.md` and `.polaris/clusters/SUMMARY.md`
*   `.polaris/runs/POLARIS.md` and `.polaris/runs/SUMMARY.md`
*   `.polaris/bootstrap/POLARIS.md` and `.polaris/bootstrap/SUMMARY.md`
*   `.polaris/map/POLARIS.md` and `.polaris/map/SUMMARY.md`

`POLARIS.md` and `SUMMARY.md` will not be created within every individual run or cluster directory by default. Adaptive cognition will be applied only when a subdirectory evolves into a stable, source-owned subsystem. The Librarian role is responsible for maintaining folder cognition and ensuring `.taskchain_artifacts/` is documented as generated/compatibility artifacts.
