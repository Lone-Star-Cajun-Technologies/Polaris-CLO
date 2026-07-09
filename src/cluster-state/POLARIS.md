# cluster-state

## Purpose

The cluster-state subsystem provides durable, atomic read/write access to per-cluster execution state (`cluster-state.json`). It tracks child lifecycle, slot claims, tracker mutations, blockers, and result/packet pointers for every cluster managed by Polaris.

**Domain:** cluster-state
**Route:** src/cluster-state

## What belongs here

- `store.ts` — `readClusterState()`, `readClusterStateSync()`, `writeClusterState()`, `writeClusterStateSync()`, `initializeClusterState()`, `pruneExpiredClaims()`: atomic state reads/writes with temp-file-plus-rename for safety
- `types.ts` — `ClusterState`, `ChildState`, `ChildLifecycleStatus`, `ClaimMetadata`, `PacketPointer`, `ResultPointer`, `ValidationResult`, `Blocker`, `TrackerMutationStatus`, `TrackerMutationReference`
- `store.test.ts`, `store.integration.test.ts`, `fixtures/` — unit and integration tests

## What does not belong here

- Loop orchestration logic — belongs in `src/loop/`
- Tracker-specific mutation logic — belongs in `src/tracker/adapters/`
- Bootstrap packet generation — belongs in `src/loop/bootstrap-packet.ts`

## Editing rules

- All writes must use `writeClusterState()` or `writeClusterStateSync()` (atomic temp-file rename). Never call `fs.writeFile(clusterStatePath, ...)` directly.
- `pruneExpiredClaims()` removes stale slot claims based on `claimed_at` and a provided expiry threshold. Call it before scheduling to ensure accurate slot counts.
- `initializeClusterState()` must produce a valid `ClusterState` with all required fields; never leave required fields `undefined`.
- `ChildLifecycleStatus` is the authoritative lifecycle enum; do not introduce new status values here without updating the dispatch state machine in `src/loop/dispatch-state.ts`.

## Architecture assumptions

- `cluster-state.json` lives at `.polaris/clusters/<cluster_id>/cluster-state.json`.
- The scheduling subsystem (`src/runtime/scheduling/child-selector.ts`) reads slot claims from cluster state to enforce `max_concurrent` limits.
- `ClusterState.tracker_mutations` defaults to `{}` (not `null`) for safe iteration.

## Read before editing

- `src/loop/dispatch-state.ts` — `WorkerDispatchState` (lifecycle enum must stay aligned)
- `src/runtime/scheduling/child-selector.ts` — consumer of `pruneExpiredClaims`
- `smartdocs/specs/active/worker-router-architecture.md` — §6 scheduler boundaries and slot invariants

## QC relationship

- Cluster-state owns durable storage of QC result pointers and metadata in `ClusterState.qc_runs`.
- QC result artifacts live at `.polaris/clusters/<cluster-id>/qc/<qc-run-id>.json` and are referenced by cluster-state pointers.
- QC status is read by finalize to determine delivery readiness and by autoresearch for SOL scoring inputs.
- `QcRunPointer.availability` (`"available" | "missing" | "unavailable"`) tracks whether the primary QC artifact and its raw provider audit artifacts (`raw_artifact_paths`, `provider_attempt_artifact_path`) still exist on disk. `validateQcArtifactPointers()` (in `src/qc/artifacts.ts`) checks existence; `pruneMissingQcRunPointers()` (in `store.ts`) removes pointers whose primary artifact is missing and marks pointers with missing raw audit artifacts as `unavailable`. Callers must persist the returned state to make pruning durable.

## QC repair loop relationship

- Cluster-state stores repair-loop outcome and manifest pointers so the repair loop survives session boundaries.
- `ClusterState.qc_repair_outcome` (`string | null`) records the QC repair loop's terminal outcome once it completes (see `QcRepairLoopOutcome` in `src/loop/checkpoint.ts` for the full value set: `pass`, `no-repairable`, `max-rounds`, `all-providers-failed`, `operator-review`, `medic-referral`, `qc-disabled`). This is a best-effort mirror of the loop checkpoint's `qc_repair_loop.terminal_outcome`, written by `src/qc/repair-loop.ts`; writes are wrapped in try/catch and must never block finalization on a cluster-state write race.
- `ClusterState.qc_repair_manifests` (`Record<number, string>`) maps repair round number to its compiled repair packet manifest path, mirroring the manifest written under `.polaris/clusters/<cluster-id>/qc/repair-rounds/<round>/repair-packets.json`.
- The maximum round count is not stored in cluster-state; it is read from `polaris.config.json → qc.maxRepairRounds` at runtime.
- Repair packet manifests are written by `src/qc/`, not by cluster-state. Cluster-state stores the pointer only.
- Finalize's `validateQcRepairLoopGate()` reads the repair-loop terminal state from the loop checkpoint (`state.qc_repair_loop`), not from `ClusterState.qc_repair_outcome`; the cluster-state field is a durability mirror for cross-session/autoresearch consumers.
- See `smartdocs/specs/active/quality-control-architecture.md §8.9` for the telemetry-aligned terminal outcome catalog that matches these string values.

## Related routes

- `src/loop/` — primary consumer of cluster state reads/writes
- `src/runtime/scheduling/` — reads slot claims for scheduling decisions
- `src/tracker/` — writes `tracker_mutations` entries
