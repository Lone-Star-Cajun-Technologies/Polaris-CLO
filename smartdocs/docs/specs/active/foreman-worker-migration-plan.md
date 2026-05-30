---
kind: spec
status: active
source: POL-217
created: 2026-05-29
implements: 
related: 
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: 
---

# Foreman-Worker Migration Plan

**Status:** Authoritative migration plan
**Issue:** POL-217
**Cluster:** POL-211
**Created:** 2026-05-29

---

## Overview

This document is the ordered migration strategy for bringing the Polaris runtime implementation into full compliance with the contracts defined in POL-212 through POL-216. It catalogs all gaps identified across the five prior specs, sequences them into executable implementation waves, defines inter-gap dependencies, and specifies the Connect readiness gate.

This is a planning document only. No source code is modified here.

---

## 1. Gap Catalog

Each gap has a canonical ID, source spec, affected files, required migration action, risk level, and dependency chain.

---

### GAP-01 — `worker-acknowledged` event not emitted

| Property | Value |
|---|---|
| **Source spec** | POL-215 (`worker-telemetry-spec.md`, §5.1); POL-213 (`worker-lifecycle-state-machine.md`, F-001) |
| **Affected files** | `src/loop/worker.ts` |
| **Risk** | Medium |
| **Depends on** | GAP-02 (worker needs `worker_id` to populate the event) |

**Description:**
`src/loop/worker.ts` reads the assignment packet but does not emit a `worker-acknowledged` event to the telemetry stream. As a result, the `acknowledged` state in the lifecycle state machine is never entered via telemetry. The Foreman cannot verify packet SHA integrity, confirm worker identity at acknowledgment time, or distinguish a worker that received the correct packet from one that did not.

**Migration action:**
1. After successful packet read and SHA computation, emit `worker-acknowledged` with `worker_id` (read from the packet or `ChildDispatchRecord`) and `packet_sha` (SHA-256 hex digest of the packet file contents).
2. Emit this event before any work output is produced.
3. Remove the interim proxy behavior in the Foreman's state derivation logic that treats the first `worker-heartbeat` as an acknowledgment proxy.

---

### GAP-02 — `WorkerLifecycleManager` is in-memory only; no durable session record with `worker_id`

| Property | Value |
|---|---|
| **Source spec** | POL-214 (`worker-session-contract.md`, §6.2, Gap 1); POL-216 (`connect-compatibility.md`, §6.1, Gap 2) |
| **Affected files** | `src/loop/checkpoint.ts`, `src/loop/worker.ts`, `src/loop/foreman.ts` (or equivalent dispatch logic) |
| **Risk** | High |
| **Depends on** | None — this is a foundational gap |

**Description:**
`ChildDispatchRecord` in `src/loop/checkpoint.ts` does not include a `worker_id` field. `worker_id` is the stable entity identifier for the worker executing a dispatch. Without it, the runtime cannot correlate Connect audit events (operator-interrupt, operator-takeover) across re-dispatch cycles. The Foreman has no per-dispatch worker entity key distinct from `dispatch_id`.

**Migration action:**
1. Add `worker_id: string` as a required field to the `ChildDispatchRecord` interface in `src/loop/checkpoint.ts`.
2. Update the Foreman dispatch logic to generate a UUID for `worker_id` at packet creation time (alongside `dispatch_id`).
3. For first-dispatch, `worker_id` MAY equal `dispatch_id`. For re-dispatch, always issue a new `worker_id`.
4. Populate `worker_id` in the packet file so workers can read and self-report it in `worker-acknowledged`.
5. For backward compatibility, treat records missing `worker_id` as `worker_id = dispatch_id`.

---

### GAP-03 — `ChildDispatchRecord` missing `session_id` and `attachment_capable` fields

| Property | Value |
|---|---|
| **Source spec** | POL-214 (`worker-session-contract.md`, §6.2, Gaps 2–3); POL-216 (`connect-compatibility.md`, §6.1, Gaps 1, 3) |
| **Affected files** | `src/loop/checkpoint.ts`, provider adapter files |
| **Risk** | High |
| **Depends on** | GAP-02 (session identity fields are part of the same schema extension) |

**Description:**
`ChildDispatchRecord` lacks two Connect-critical fields:
- `session_id: string | null` — the provider-assigned session identifier used as the primary attachment handle for Connect features (live terminal, interrupt, takeover).
- `attachment_capable: boolean` — the hard gate that Connect evaluates before attempting any session-addressed operation.

Without these fields, all three Connect features requiring session addressability (`LIVE_TERMINAL`, `WORKER_INTERRUPTION`, `WORKER_TAKEOVER`) cannot function for any dispatch record written before they are added. The `worker_assignment.subagent_session_id` nested field partially overlaps but is provider-specific and not Connect-addressable.

**Migration action:**
1. Add `session_id: string | null` to `ChildDispatchRecord` in `src/loop/checkpoint.ts`. Default to `null` at packet creation.
2. Add `attachment_capable: boolean` to `ChildDispatchRecord`. Default to `false` at packet creation.
3. Update each provider adapter to set `session_id` after provider session establishment.
4. Update each provider adapter to set `attachment_capable` based on the static provider capability matrix defined in `connect-compatibility.md` §4.
5. `worker_assignment.subagent_session_id` is retained for backward compatibility but `session_id` is now the canonical field.

---

### GAP-04 — Delegated dispatch creates packet but does not attempt subagent spawn or write assignment record

| Property | Value |
|---|---|
| **Source spec** | POL-212 (`foreman-worker-architecture.md`, §3.2–§3.3) |
| **Affected files** | `src/loop/foreman.ts` (or equivalent dispatch orchestration), `src/loop/checkpoint.ts` |
| **Risk** | High |
| **Depends on** | GAP-02 (assignment record needs `worker_id`), GAP-03 (record needs `session_id`, `attachment_capable`), GAP-05 (assignment events must be emitted as part of this flow) |

**Description:**
In delegated dispatch mode, the runtime writes a packet but does not follow through with the subagent spawn attempt, the assignment evidence write, or the escalation fallback chain. The `ChildDispatchRecord.worker_assignment` record is not populated. Assignment evidence (`assigned_at`, `assignment_type`) is absent. The dispatch exits in an indeterminate state with no mechanism to verify whether work was handed off.

**Migration action:**
1. After writing the packet, attempt subagent spawning per the architecture spec (§3.2).
2. On subagent spawn success: populate `worker_assignment` with `assigned_at`, `assignment_type: "subagent"`, and `subagent_session_id`; set `session_id` on `ChildDispatchRecord`.
3. On spawn failure: attempt external-process fallback; on that failure, attempt human-handoff; on that failure, emit `pending-escalation`.
4. Write `ChildDispatchRecord` with complete assignment evidence before the worker begins execution (per §3.3 invariant: evidence-before-execution).
5. Emit assignment events per GAP-05 at each decision point in the fallback chain.

---

### GAP-05 — Assignment events never emitted despite being type-defined

| Property | Value |
|---|---|
| **Source spec** | POL-215 (`worker-telemetry-spec.md`, §2.8–§2.11); POL-213 (`worker-lifecycle-state-machine.md`, §3.2) |
| **Affected files** | `src/loop/dispatch-state.ts`, `src/loop/foreman.ts` (or equivalent dispatch orchestration) |
| **Risk** | Medium |
| **Depends on** | GAP-04 (the assignment flow must exist before events can be emitted from it) |

**Description:**
The following assignment events are defined as types in `src/loop/dispatch-state.ts` but are never emitted at runtime:
- `worker-assignment-attempted` — intent to assign; emitted before outcome is known
- `worker-assigned` — confirms successful assignment with session/PID identity
- `worker-assignment-failed` — records failure of an assignment attempt
- `escalation-initiated` — signals all automatic mechanisms exhausted

Without these events, the telemetry stream cannot answer "who owns this child?" and the state machine cannot transition through the assignment handoff correctly. The `handoff-pending` → `acknowledged` path in the lifecycle state machine has no observable evidence.

**Migration action:**
1. In the Foreman's dispatch logic (integrated with GAP-04), emit `worker-assignment-attempted` before each assignment mechanism attempt.
2. On successful assignment, emit `worker-assigned` with `assignment_type`, `session_id` (if subagent), `process_pid` (if external-process), `handoff_token` (if human-handoff).
3. On failed assignment attempt, emit `worker-assignment-failed` with `reason`.
4. When all mechanisms are exhausted, emit `escalation-initiated` with `reason` and `recommended_action`.
5. Events must be written to the telemetry log (NDJSON) before transitioning dispatch state.

---

### GAP-06 — `status.ts` cannot answer "has worker accepted" or "can session be attached"

| Property | Value |
|---|---|
| **Source spec** | POL-215 (`worker-telemetry-spec.md`, §4 Lifecycle Coverage Map); POL-216 (`connect-compatibility.md`, §6.1) |
| **Affected files** | `src/loop/status.ts` (or equivalent status/query layer) |
| **Risk** | Medium |
| **Depends on** | GAP-01 (worker-acknowledged must be emitted), GAP-03 (attachment_capable must be stored) |

**Description:**
The runtime status layer cannot answer two operational questions that the spec requires it to answer:
1. "Has a worker accepted the work?" — requires `worker-acknowledged` event or `runtime_state: "acknowledged"`.
2. "Can the session be attached?" — requires `attachment_capable: true` AND `session_id` non-null.

These are the primary queries that Connect's live terminal, interrupt, and takeover features issue before attempting any session-addressed operation.

**Migration action:**
1. Expose a `hasWorkerAcknowledged(dispatch_id)` query that checks for a `worker-acknowledged` event in the telemetry log for the given `dispatch_id`, or checks `runtime_state >= "acknowledged"` in `ChildDispatchRecord`.
2. Expose a `canSessionBeAttached(dispatch_id)` query that checks `attachment_capable === true && session_id !== null` on `ChildDispatchRecord`.
3. Both queries must be available without loading the full telemetry log (read from `ChildDispatchRecord` only, with telemetry as fallback for the acknowledgment query).

---

### GAP-07 — No explicit `acknowledged` state in the lifecycle state machine implementation

| Property | Value |
|---|---|
| **Source spec** | POL-213 (`worker-lifecycle-state-machine.md`, §6.4, F-001) |
| **Affected files** | `src/loop/dispatch-state.ts` |
| **Risk** | Medium |
| **Depends on** | GAP-01 (acknowledged event must be emitted before the state can be entered) |

**Description:**
`WorkerDispatchState` in `src/loop/dispatch-state.ts` has no `"acknowledged"` state. The transition `handoff-pending` → `acknowledged` is absent from `isValidTransition()`. As a result, the lifecycle machine jumps directly from `launching` to `running` without an intermediate confirmation that the correct worker received the correct packet.

**Migration action:**
1. Add `"acknowledged"` to the `WorkerDispatchState` union type in `src/loop/dispatch-state.ts`.
2. Add transitions: `"launching"` → `"acknowledged"` and `"acknowledged"` → `"running"` (or `"failed"`) to `isValidTransition()`.
3. Update `deriveDispatchState()` to enter `"acknowledged"` when a `worker-acknowledged` event is present for the dispatch.
4. Retire the proxy behavior that uses the first `worker-heartbeat` as an acknowledgment proxy (post GAP-01 implementation).

---

### GAP-08 — `packet-created` → `failed` transition missing from `isValidTransition()`

| Property | Value |
|---|---|
| **Source spec** | POL-213 (`worker-lifecycle-state-machine.md`, §6.4, F-002) |
| **Affected files** | `src/loop/dispatch-state.ts` |
| **Risk** | Low |
| **Depends on** | None |

**Description:**
`isValidTransition()` does not allow `packet-created` → `failed`. However, the canonical state machine requires this transition for the case where seal verification fails or the packet write fails before any handoff attempt. Without this allowed transition, Foreman logic that detects pre-handoff failure cannot formally transition to `failed` through the state machine.

**Migration action:**
1. Add `"packet-created"` → `"failed"` to the `isValidTransition()` allowed set in `src/loop/dispatch-state.ts`.
2. Document the trigger condition: seal verification failure or packet write failure before dispatch initiation.

---

### GAP-09 — `running` → `orphaned` transition missing from `isValidTransition()`

| Property | Value |
|---|---|
| **Source spec** | POL-213 (`worker-lifecycle-state-machine.md`, §6.4, F-003) |
| **Affected files** | `src/loop/dispatch-state.ts` |
| **Risk** | Medium |
| **Depends on** | None |

**Description:**
`isValidTransition()` does not allow `running` → `orphaned`. The current implementation only allows `blocked` → `orphaned`, which misses the case where a running worker goes silent without first emitting a `worker-blocked` event. A worker that simply stops sending heartbeats while in `running` state cannot be transitioned to `orphaned` through the formal state machine.

**Migration action:**
1. Add `"running"` → `"orphaned"` to the `isValidTransition()` allowed set.
2. Update `deriveDispatchState()` to apply the `orphan_timeout_ms` threshold from the `running` state directly, not only from `blocked`.
3. This ensures `orphaned` is reachable from both `running` and `blocked` per the canonical spec.

---

### GAP-10 — `delegated` → `blocked` (launch timeout) transition missing

| Property | Value |
|---|---|
| **Source spec** | POL-213 (`worker-lifecycle-state-machine.md`, §6.4, F-004) |
| **Affected files** | `src/loop/dispatch-state.ts` |
| **Risk** | Low |
| **Depends on** | None |

**Description:**
`isValidTransition()` does not model `delegated` → `blocked`. The canonical spec requires that when `launch_to_first_heartbeat_ms` expires while in `handoff-pending` (implementation equivalent: `delegated`) state, the dispatch transitions to `blocked`. This edge case is currently unrepresentable.

**Migration action:**
1. Add `"delegated"` → `"blocked"` to the `isValidTransition()` allowed set.
2. Update `deriveDispatchState()` to apply the `launch_to_first_heartbeat_ms` threshold from the `delegated` state.

---

### GAP-11 — `ChildDispatchRecord` missing `heartbeat_count` and `first_heartbeat_at`

| Property | Value |
|---|---|
| **Source spec** | POL-214 (`worker-session-contract.md`, §3.1, Gaps 4–5); POL-216 (`connect-compatibility.md`, §6.1, Gaps 4–5) |
| **Affected files** | `src/loop/checkpoint.ts`, `src/loop/foreman.ts` (heartbeat handling logic) |
| **Risk** | Low |
| **Depends on** | None — standalone addition |

**Description:**
`ChildDispatchRecord` lacks `heartbeat_count` and `first_heartbeat_at`. These fields enable Connect's Session Viewing feature and are required dispatch quality metrics:
- `heartbeat_count`: total heartbeats received; enables heartbeat gap detection.
- `first_heartbeat_at`: timestamp of first heartbeat; enables time-to-first-heartbeat computation.

**Migration action:**
1. Add `heartbeat_count?: number` to `ChildDispatchRecord` in `src/loop/checkpoint.ts`. Default to `0`.
2. Add `first_heartbeat_at?: string` to `ChildDispatchRecord`. Set on first heartbeat receipt.
3. In the Foreman's heartbeat handler: increment `heartbeat_count` on each heartbeat; set `first_heartbeat_at` if not already set.

---

### GAP-12 — State names in `WorkerDispatchState` diverge from canonical names

| Property | Value |
|---|---|
| **Source spec** | POL-213 (`worker-lifecycle-state-machine.md`, §6.4, F-006) |
| **Affected files** | `src/loop/dispatch-state.ts` |
| **Risk** | Low |
| **Depends on** | GAP-07, GAP-08, GAP-09, GAP-10 (state machine changes should align with canonical names if renaming is done) |

**Description:**
Implementation state names (`packet-created`, `delegated`, `launching`) differ from canonical spec names (`capability-detected`, `handoff-pending`, `assigned`). This divergence creates friction between documentation/tooling that uses canonical names and code that uses implementation names.

**Migration action:**
1. Decide whether to rename implementation states or maintain the divergence with a documented mapping table.
2. If renaming: update `WorkerDispatchState` type, all `isValidTransition()` entries, `deriveDispatchState()`, and all consumers.
3. If maintaining divergence: publish the canonical ↔ implementation name mapping as a constant in `dispatch-state.ts`.
4. Note: renaming is breaking for any code or data that persists state strings (checkpoint records). A migration path for existing checkpoint records is required.

---

## 2. Migration Waves

Gaps are organized into implementation waves. Each wave is a self-contained unit of work that can be delivered as a standalone PR. Wave N+1 may not begin until all gaps in Wave N are complete.

---

### Wave 1 — Schema Foundation (unblocks all Connect features)

**Rationale:** All Connect features require the schema fields defined in this wave. These changes are additive and non-breaking. They have no implementation dependencies on other waves.

| Gap | Action | Files |
|---|---|---|
| GAP-02 | Add `worker_id` to `ChildDispatchRecord` | `src/loop/checkpoint.ts` |
| GAP-03 | Add `session_id`, `attachment_capable` to `ChildDispatchRecord` | `src/loop/checkpoint.ts` |
| GAP-11 | Add `heartbeat_count`, `first_heartbeat_at` to `ChildDispatchRecord` | `src/loop/checkpoint.ts` |
| GAP-08 | Add `packet-created` → `failed` transition | `src/loop/dispatch-state.ts` |
| GAP-10 | Add `delegated` → `blocked` transition | `src/loop/dispatch-state.ts` |

**PR scope:** Schema additions and transition additions only. No behavior changes. Backward-compatible: existing records missing new fields are treated as default values (`worker_id = dispatch_id`, `session_id = null`, `attachment_capable = false`, `heartbeat_count = 0`).

---

### Wave 2 — Dispatch Flow Completion (enables assignment evidence and Connect session storage)

**Rationale:** Once the schema is extended, the dispatch flow can be updated to populate the new fields and emit the assignment events.

**Prerequisite:** Wave 1 complete.

| Gap | Action | Files |
|---|---|---|
| GAP-04 | Implement subagent spawn, external-process fallback, assignment record write | `src/loop/foreman.ts`, `src/loop/checkpoint.ts` |
| GAP-05 | Emit assignment events (`worker-assignment-attempted`, `worker-assigned`, `worker-assignment-failed`, `escalation-initiated`) | `src/loop/foreman.ts`, `src/loop/dispatch-state.ts` |

**PR scope:** Dispatch flow logic and telemetry event emission. No schema changes (schema was extended in Wave 1). The adapter layer must populate `session_id` and `attachment_capable` on successful assignment.

---

### Wave 3 — Worker Acknowledgment (enables `acknowledged` state and packet integrity verification)

**Rationale:** Worker-side change. Depends on `worker_id` being available in the packet (Wave 1 + Wave 2) so the worker can report it in the acknowledgment event.

**Prerequisite:** Wave 2 complete (packet must contain `worker_id`).

| Gap | Action | Files |
|---|---|---|
| GAP-01 | Emit `worker-acknowledged` from `src/loop/worker.ts` | `src/loop/worker.ts` |
| GAP-07 | Add `acknowledged` state and transitions to `isValidTransition()` and `deriveDispatchState()` | `src/loop/dispatch-state.ts` |
| GAP-09 | Add `running` → `orphaned` transition to `isValidTransition()` | `src/loop/dispatch-state.ts` |

**PR scope:** Worker bootstrap change (acknowledgment emission) and state machine extension. The interim heartbeat proxy behavior in the Foreman's state derivation should be retired in this wave after `worker-acknowledged` is confirmed working.

---

### Wave 4 — Status Query Layer (enables Connect operational queries)

**Rationale:** Once the underlying data is present (Waves 1–3), the status query layer can be updated to expose the answers Connect needs.

**Prerequisite:** Wave 3 complete.

| Gap | Action | Files |
|---|---|---|
| GAP-06 | Implement `hasWorkerAcknowledged()` and `canSessionBeAttached()` queries | `src/loop/status.ts` |

**PR scope:** Query layer additions only. No state machine or schema changes.

---

### Wave 5 — State Name Alignment (optional; deferred)

**Rationale:** Renaming implementation state names to canonical names is a low-risk but wide-surface change. It should be deferred until Waves 1–4 are stable and there is no active checkpoint data that would require a data migration.

**Prerequisite:** Waves 1–4 complete.

| Gap | Action | Files |
|---|---|---|
| GAP-12 | Rename or document `WorkerDispatchState` state names | `src/loop/dispatch-state.ts` and all consumers |

**PR scope:** Naming change or mapping table addition. Requires coordination with any tooling that reads persisted state strings from checkpoint files.

---

## 3. Dependency Graph

```
GAP-02 (worker_id schema)
    └── GAP-04 (dispatch flow)
            └── GAP-05 (assignment events)
                    └── GAP-01 (worker-acknowledged)
                                └── GAP-06 (status queries: has-accepted)
                                └── GAP-07 (acknowledged state in machine)

GAP-03 (session_id, attachment_capable)
    └── GAP-04 (dispatch flow populates these)
    └── GAP-06 (status queries: can-attach)

GAP-11 (heartbeat_count, first_heartbeat_at) — standalone

GAP-08 (packet-created → failed) — standalone
GAP-09 (running → orphaned) — standalone
GAP-10 (delegated → blocked) — standalone

GAP-12 (state name alignment) — depends on all other machine changes
```

---

## 4. Connect Readiness Gate

The following conditions define "Connect-ready" for the session model. **All gaps in the Connect readiness gate MUST be closed before any Connect feature flag can be enabled in production.**

### 4.1 Minimum Connect Readiness (enables `CONNECT_FEATURE_SESSION_VIEWING` and `CONNECT_FEATURE_MULTI_WORKER_VISIBILITY`)

| Required closed gap | What it unlocks |
|---|---|
| GAP-02 (`worker_id` on dispatch record) | Session Viewing: links Connect session to dispatch record for audit |
| GAP-11 (`heartbeat_count`, `first_heartbeat_at`) | Session Viewing: heartbeat history and quality metrics |
| GAP-04 (assignment record populated) | Multi-Worker: `open_children_meta` dispatch records have complete state |
| GAP-05 (assignment events emitted) | Multi-Worker: event timeline is complete from dispatch initiation |

Minimum readiness = **Wave 1 + Wave 2**.

---

### 4.2 Full Session Addressability (enables `CONNECT_FEATURE_LIVE_TERMINAL`, `CONNECT_FEATURE_WORKER_INTERRUPTION`, `CONNECT_FEATURE_WORKER_TAKEOVER`)

These features require session attachment (`attachment_capable: true` + non-null `session_id`). Session addressability requires:

| Required closed gap | What it unlocks |
|---|---|
| GAP-03 (`session_id`, `attachment_capable` on dispatch record) | All attachment-dependent features: Live Terminal, Interruption, Takeover |
| GAP-04 (dispatch flow populates `session_id` from provider) | `session_id` is non-null for attachment-capable providers |
| GAP-06 (`canSessionBeAttached()` query) | Connect reads attachment capability without provider-specific logic |

Full session addressability = **Waves 1–4**.

---

### 4.3 Connect Readiness Invariants

The following invariants must hold before any Connect feature flag is enabled:

| Invariant | Verified by |
|---|---|
| Every active `ChildDispatchRecord` has `worker_id` (non-null, non-empty) | Schema constraint added in GAP-02 + Foreman enforcement in GAP-04 |
| Every active `ChildDispatchRecord` has `attachment_capable` (boolean, not undefined) | Schema default `false` added in GAP-03 |
| Every active `ChildDispatchRecord` has `session_id` (may be null; never undefined) | Schema default `null` added in GAP-03 |
| Assignment events are present in the telemetry log for every dispatch from migration date forward | GAP-05 |
| `hasWorkerAcknowledged()` returns a result (not throws) for any dispatch | GAP-06 |
| `canSessionBeAttached()` returns a boolean (not throws) for any dispatch | GAP-06 |

---

## 5. Risk Summary

| Gap | Risk | Rationale |
|---|---|---|
| GAP-01 | Medium | Worker-side change; must not break existing execution paths; interim proxy must be cleanly retired |
| GAP-02 | High | Foundational schema change; affects all dispatch records; must be backward-compatible |
| GAP-03 | High | Session identity fields required by Connect; must be populated correctly by each provider adapter |
| GAP-04 | High | Core dispatch flow change; subagent spawn path must be tested against all fallback levels |
| GAP-05 | Medium | Event emission change; new code paths; low risk of breaking existing behavior but must not double-emit |
| GAP-06 | Medium | Status query layer; surface area for incorrect answers if underlying data is missing |
| GAP-07 | Medium | State machine structural change; must not break existing state derivation for records without the new state |
| GAP-08 | Low | Additive transition; no existing code paths are affected |
| GAP-09 | Low | Additive transition; orphan detection from `running` is new coverage; no regression risk |
| GAP-10 | Low | Additive transition; launch-timeout-from-delegated is new coverage |
| GAP-11 | Low | Additive schema fields; no existing behavior changes |
| GAP-12 | Low | Naming only; risk is proportional to the surface area of consumers and checkpoint data migration scope |

---

## 6. Out-of-Scope Items

The following are explicitly excluded from this migration plan:

- **Connect implementation**: No Connect UI, streaming proxy, or operator authentication is covered. This plan covers only the Polaris-side storage and event emission commitments.
- **Provider adapter implementations**: While GAP-04 requires dispatch flow changes, per-provider adapter implementations (Copilot, Gemini, Codex, Windsurf) are governed by their respective adapter specs, not this plan.
- **Re-dispatch mechanics**: Re-dispatch (new `dispatch_id`, new `worker_id`) is described in the session contract but not sequenced here. It is a future concern once the first-dispatch path is stable.
- **`operator-interrupt` and `operator-takeover` event schemas**: These are future Connect → Polaris API events. Polaris's `appendAuditEvent` function is not specified here.

---

## 7. Related Specs

| Spec | Issue | Description |
|---|---|---|
| `foreman-worker-architecture.md` | POL-212 | Foreman doctrine, worker doctrine, dispatch modes, escalation paths |
| `worker-lifecycle-state-machine.md` | POL-213 | All 9 lifecycle states, transition graph, findings F-001–F-006 |
| `worker-session-contract.md` | POL-214 | Canonical `ChildDispatchRecord` session fields, gap analysis |
| `worker-telemetry-spec.md` | POL-215 | All 11 event types, implementation gaps |
| `connect-compatibility.md` | POL-216 | Connect features, feature flags, migration cost analysis |
