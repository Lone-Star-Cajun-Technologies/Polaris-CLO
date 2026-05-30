---
kind: spec
status: active
source: POL-213
created: 2026-05-29
implements: 
related: smartdocs/docs/specs/active/foreman-worker-architecture.md,smartdocs/docs/specs/active/worker-session-contract.md
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: src/loop/dispatch-state.ts,src/loop/dispatch-boundary.ts
---

# Worker Lifecycle State Machine Spec

**Status:** Authoritative spec  
**Issue:** POL-213  
**Cluster:** POL-211  
**Created:** 2026-05-29

---

## Overview

This document formally specifies the complete Worker Lifecycle State Machine for the Polaris runtime. It defines all 9 canonical states, their entry and exit conditions, required evidence for every transition, ownership assignments, timeout behavior, and the complete allowed transition graph.

This spec is authoritative. Implementation files `src/loop/dispatch-state.ts` and `src/loop/dispatch-boundary.ts` are the current partial implementation. Where the implementation diverges from this spec, the divergence is noted as a finding. The implementation is not modified by this document — findings inform future remediation work.

---

## 1. State Definitions

### 1.1 State Inventory

The Worker Lifecycle State Machine has 9 canonical states:

| # | Canonical State | Phase | Owner |
|---|---|---|---|
| 1 | `capability-detected` | Pre-assignment | Foreman |
| 2 | `handoff-pending` | Pre-assignment | Foreman |
| 3 | `acknowledged` | Assignment handoff | Worker |
| 4 | `assigned` | Assignment confirmed | Foreman |
| 5 | `running` | Active execution | Worker |
| 6 | `blocked` | Suspended execution | Foreman |
| 7 | `completed` | Terminal: success | Foreman |
| 8 | `failed` | Terminal: failure | Foreman |
| 9 | `orphaned` | Terminal: lost | Foreman |

Terminal states: `completed`, `failed`, `orphaned`. No transitions out of terminal states are valid.

---

### 1.2 `capability-detected`

**Description:** A child issue has been selected from the open queue and a viable execution capability (subagent, external-process, or human-handoff) has been identified. The assignment packet exists but has not yet been handed to any worker.

**Entry condition:** The Foreman has selected the next child, verified the `run_bootstrap_seal`, identified an eligible dispatch mechanism, and written the assignment packet to `packet_path`.

**Exit conditions:**

| Exit State | Trigger |
|---|---|
| `handoff-pending` | Foreman begins transferring the packet to the target worker mechanism |
| `failed` | Packet write fails or seal verification fails before any handoff attempt |

**Required evidence before entry:**
- `packet_path` written to disk (durable artifact)
- `dispatch_id` assigned (UUID)
- `run_bootstrap_seal` verified
- `ChildDispatchRecord` written with `runtime_state: "capability-detected"`

**Owner:** Foreman

**Timeout:** None. This is a transient coordination state; the Foreman must exit it within the same dispatch invocation.

---

### 1.3 `handoff-pending`

**Description:** The Foreman is actively transferring the assignment to a worker mechanism. The dispatch has been initiated but the worker has not yet acknowledged the packet. This covers the window from dispatch initiation to first worker acknowledgment.

**Entry condition:** The Foreman has emitted a dispatch signal appropriate to the dispatch mode:
- For subagent: subagent spawn call has been issued
- For external-process: process launch command has been issued
- For human-handoff: handoff request has been emitted with `handoff_token`
- For direct-worker: provider-specific dispatch signal has been sent

**Exit conditions:**

| Exit State | Trigger |
|---|---|
| `acknowledged` | Worker emits acknowledgment event |
| `failed` | Dispatch mechanism fails (spawn error, process exit before ack, provider API error) |
| `blocked` | `launch_to_first_heartbeat_ms` timeout expires without acknowledgment |

**Required evidence before entry:**
- `WorkerAssignedEvent` or `WorkerAssignmentAttemptedEvent` written to telemetry
- `ChildDispatchRecord.worker_assignment.assigned_at` set
- `ChildDispatchRecord.worker_assignment.assignment_type` set

**Owner:** Foreman

**Timeout:** `launch_to_first_heartbeat_ms` (default: 30,000 ms). If acknowledgment is not received within this window, the state transitions to `blocked`.

---

### 1.4 `acknowledged`

**Description:** The worker has confirmed receipt of the assignment packet. The worker identity is known and the worker is preparing to begin execution. No work output has been produced yet.

**Entry condition:** Worker has read the packet at `packet_path`, validated its contents, and emitted an acknowledgment record to the checkpoint system containing `dispatch_id`, `child_id`, `acknowledged_at`, and `worker_identity`.

**Exit conditions:**

| Exit State | Trigger |
|---|---|
| `assigned` | Foreman records acknowledgment and confirms assignment is live |
| `failed` | Worker emits failure CompactReturn immediately after acknowledgment (e.g., packet integrity violation) |

**Required evidence before entry:**
- Acknowledgment record written to checkpoint (durable artifact):
  - `dispatch_id` (matches packet)
  - `child_id` (matches packet)
  - `acknowledged_at` (ISO 8601)
  - `worker_identity` (session ID, PID, or provider-assigned ID)

**Owner:** Worker (emits evidence); Foreman (observes and confirms)

**Timeout:** None as a distinct state. If the worker emits an acknowledgment but does not proceed to emitting heartbeats, the `launch_to_first_heartbeat_ms` timeout (tracked from the original handoff) governs transition to `blocked`.

---

### 1.5 `assigned`

**Description:** The Foreman has confirmed the acknowledgment and the assignment is live. The worker is starting execution. This is the confirmed-active state before the first heartbeat is received.

**Entry condition:** Foreman has observed the worker's acknowledgment record and updated `ChildDispatchRecord.runtime_state` to `"assigned"`.

**Exit conditions:**

| Exit State | Trigger |
|---|---|
| `running` | First `worker-heartbeat` event received |
| `blocked` | `launch_to_first_heartbeat_ms` timeout expires after acknowledgment without a heartbeat |
| `failed` | Worker emits `worker-result` with `status: "failure"` before first heartbeat |
| `completed` | Worker emits `worker-result` with `status: "success"` before first heartbeat (fast-path completion) |

**Required evidence before entry:**
- `ChildDispatchRecord.runtime_state` updated to `"assigned"` (durable artifact)
- Acknowledgment record present in checkpoint (from `acknowledged` entry)

**Owner:** Foreman

**Timeout:** `launch_to_first_heartbeat_ms` from the handoff initiation time (default: 30,000 ms). Shared with the `handoff-pending`/`acknowledged` window.

---

### 1.6 `running`

**Description:** The worker is actively executing its assignment and producing regular heartbeat telemetry. This is the primary active execution state.

**Entry condition:** A `worker-heartbeat` event has been received from the worker with a timestamp within the `heartbeat_interval_ms` window.

**Exit conditions:**

| Exit State | Trigger |
|---|---|
| `blocked` | Worker emits `worker-blocked` event (needs approval) OR heartbeat interval exceeds `heartbeat_interval_ms` |
| `completed` | Worker emits `worker-result` with `status: "success"` |
| `failed` | Worker emits `worker-result` with `status: "failure"` OR `worker-rejected` event received |
| `orphaned` | Time since last heartbeat exceeds `orphan_timeout_ms` |

**Required evidence before entry:**
- `worker-heartbeat` telemetry event with `step_cursor`, `dispatch_id`, `child_id`, `run_id`, `timestamp`

**Owner:** Worker (emits evidence); Foreman (monitors and transitions)

**Timeout:**
- Stale heartbeat: if `now - last_heartbeat_at > heartbeat_interval_ms` (default: 300,000 ms), transition to `blocked`
- Orphan: if `now - last_heartbeat_at > orphan_timeout_ms` (default: 600,000 ms), transition to `orphaned`

---

### 1.7 `blocked`

**Description:** The worker's execution is suspended. This covers two sub-cases: (a) the worker explicitly requested approval via a `worker-blocked` event, or (b) the Foreman detected a stale heartbeat and no result has been written. The worker is not making progress.

**Entry conditions:**
- Worker emitted `worker-blocked` event (approval-blocked sub-case), OR
- `heartbeat_interval_ms` elapsed without a new heartbeat and no terminal result (stale sub-case), OR
- `launch_to_first_heartbeat_ms` elapsed without any heartbeat after `handoff-pending` (launch-stale sub-case)

**Exit conditions:**

| Exit State | Trigger |
|---|---|
| `running` | `worker-approved` or `worker-auto-approved` event resolves the blocker AND a subsequent heartbeat is received |
| `completed` | Worker emits `worker-result` with `status: "success"` after resolution |
| `failed` | `worker-rejected` event received, OR `approval_timeout_ms` exceeded, OR Foreman manually fails |
| `orphaned` | `orphan_timeout_ms` exceeded from last known telemetry timestamp |

**Required evidence before entry:**
- For approval-blocked: `worker-blocked` telemetry event with `blocker_id`, `reason`, `approval_type`, `description`
- For stale: Foreman-internal timeout detection (no additional telemetry event required; Foreman writes state update)

**Owner:** Foreman (owns resolution decisions); Worker (emitted the block trigger)

**Timeout:**
- Approval timeout: if in approval-blocked sub-case and `now - blocked_at > approval_timeout_ms` (default: 3,600,000 ms), transition to `failed`
- Orphan timeout: if `now - last_telemetry_at > orphan_timeout_ms` (default: 600,000 ms), transition to `orphaned`

---

### 1.8 `completed`

**Description:** The worker finished execution successfully. All assigned work is done. The Foreman may advance the queue.

**Entry condition:** Worker emitted `worker-result` event with `status: "success"` and `exit_code: 0`. CompactReturn is written to `expected_result_path`.

**Exit conditions:** None. `completed` is a terminal state.

**Required evidence before entry:**
- `worker-result` telemetry event with `status: "success"`, `exit_code: 0`
- CompactReturn file present at `expected_result_path` (durable artifact)
- CompactReturn contains `child_id`, `run_id`, `dispatch_id`, `exit_code: 0`, `status: "success"`, `completed_at`, `summary`

**Owner:** Foreman (sets terminal state after observing evidence)

**Timeout:** N/A (terminal state)

---

### 1.9 `failed`

**Description:** The worker finished with an error, or a runtime condition forced a failure determination (rejection, approval timeout, seal violation). The child cannot be advanced without Foreman intervention.

**Entry conditions:**
- Worker emitted `worker-result` with `status: "failure"` and non-zero `exit_code`, OR
- `worker-rejected` event received for an unresolved blocker, OR
- `approval_timeout_ms` exceeded while in `blocked` state, OR
- Dispatch mechanism failed (spawn error, provider API error, process launch failure), OR
- Packet integrity violation detected by worker, OR
- `run_bootstrap_seal` verification failure

**Exit conditions:** None. `failed` is a terminal state.

**Required evidence before entry:**
- For worker failure: `worker-result` with `status: "failure"`, `exit_code != 0`, `error` field present
- For rejection: `worker-rejected` event with `blocker_id`, `rejected_by`, `rejection_reason`
- For approval timeout: Foreman-internal timeout detection (Foreman writes state update with `reason: "approval-timeout"`)
- For dispatch failure: `WorkerAssignmentFailedEvent` with `reason`
- For seal violation: `SEAL_INTEGRITY_VIOLATION` audit event (per foreman-worker-architecture.md §3.5)

**Owner:** Foreman

**Timeout:** N/A (terminal state)

---

### 1.10 `orphaned`

**Description:** The worker has gone silent. No telemetry has been received for longer than `orphan_timeout_ms` and no terminal result exists. The worker's status cannot be determined. The child is considered lost.

**Entry condition:** `now - last_known_telemetry_at > orphan_timeout_ms` with no `worker-result` event present. This can be entered from `running`, `blocked`, or `assigned` states.

**Exit conditions:** None. `orphaned` is a terminal state.

**Required evidence before entry:**
- Foreman-internal timeout detection: `orphan_timeout_ms` elapsed since last telemetry event
- Absence of any `worker-result` event for the `dispatch_id`
- Foreman writes `ChildDispatchRecord.runtime_state: "orphaned"` with `orphaned_at` timestamp

**Owner:** Foreman

**Timeout:** N/A (terminal state)

---

## 2. Allowed Transition Graph

### 2.1 Complete Transition Table

| From | To | Trigger | Evidence Required |
|---|---|---|---|
| `capability-detected` | `handoff-pending` | Foreman initiates dispatch to worker mechanism | `WorkerAssignedEvent` or `WorkerAssignmentAttemptedEvent`; `worker_assignment.assigned_at` set |
| `capability-detected` | `failed` | Seal verification fails or packet write fails | `SEAL_INTEGRITY_VIOLATION` audit event or packet write error log |
| `handoff-pending` | `acknowledged` | Worker emits acknowledgment record | Acknowledgment record in checkpoint with `dispatch_id`, `worker_identity` |
| `handoff-pending` | `failed` | Dispatch mechanism fails before any ack | `WorkerAssignmentFailedEvent` with `reason` |
| `handoff-pending` | `blocked` | `launch_to_first_heartbeat_ms` expires with no ack | Foreman timeout detection; state update written |
| `acknowledged` | `assigned` | Foreman observes and confirms acknowledgment | `ChildDispatchRecord.runtime_state` updated to `"assigned"` |
| `acknowledged` | `failed` | Worker emits failure CompactReturn after ack | `worker-result` with `status: "failure"` |
| `assigned` | `running` | First heartbeat received | `worker-heartbeat` event with `dispatch_id`, `step_cursor` |
| `assigned` | `blocked` | `launch_to_first_heartbeat_ms` expires after ack | Foreman timeout detection; state update written |
| `assigned` | `failed` | Worker emits failure result before first heartbeat | `worker-result` with `status: "failure"` |
| `assigned` | `completed` | Worker emits success result before first heartbeat | `worker-result` with `status: "success"`; CompactReturn at `expected_result_path` |
| `running` | `blocked` | `worker-blocked` event received | `worker-blocked` with `blocker_id`, `reason`, `approval_type` |
| `running` | `blocked` | `heartbeat_interval_ms` exceeded | Foreman timeout detection; state update written |
| `running` | `completed` | `worker-result` with success received | `worker-result` with `status: "success"`; CompactReturn at `expected_result_path` |
| `running` | `failed` | `worker-result` with failure received | `worker-result` with `status: "failure"`, `exit_code != 0` |
| `running` | `failed` | `worker-rejected` event received | `worker-rejected` with `blocker_id`, `rejected_by` |
| `running` | `orphaned` | `orphan_timeout_ms` exceeded | Foreman timeout detection; absence of terminal result |
| `blocked` | `running` | Approval granted and subsequent heartbeat received | `worker-approved` or `worker-auto-approved` with `blocker_id`; then `worker-heartbeat` |
| `blocked` | `completed` | Worker emits success result after resolution | `worker-result` with `status: "success"`; CompactReturn at `expected_result_path` |
| `blocked` | `failed` | `worker-rejected` received | `worker-rejected` with `blocker_id`, `rejected_by` |
| `blocked` | `failed` | `approval_timeout_ms` exceeded | Foreman timeout detection; state update written with `reason: "approval-timeout"` |
| `blocked` | `orphaned` | `orphan_timeout_ms` exceeded from last telemetry | Foreman timeout detection; absence of terminal result |

### 2.2 Transition Graph Diagram

```
capability-detected
    │
    ├──[seal/packet fail]──────────────────────────────► failed
    │
    └──[dispatch initiated]──► handoff-pending
                                    │
                                    ├──[mechanism fail]────────────────► failed
                                    ├──[launch timeout]────────────────► blocked
                                    │
                                    └──[ack received]──► acknowledged
                                                              │
                                                              ├──[failure result]────────► failed
                                                              │
                                                              └──[foreman confirms]──► assigned
                                                                                          │
                                                                                          ├──[first heartbeat]──► running ─────────────────────────────────────────────────────────┐
                                                                                          ├──[launch timeout]──► blocked                                                            │
                                                                                          ├──[failure result]──► failed             [blocked]◄──[worker-blocked / stale heartbeat]──┘
                                                                                          └──[success result]──► completed              │
                                                                                                                                        ├──[approved + heartbeat]──► running
                                                                                                                                        ├──[success result]────────► completed
                                                                                                                                        ├──[rejected / timeout]────► failed
                                                                                                                                        └──[orphan timeout]────────► orphaned
                                                                                                                                                                        (terminal)
```

---

## 3. Evidence Requirements by Transition

### 3.1 Evidence Taxonomy

Every transition requires three types of evidence:

| Evidence Type | Description |
|---|---|
| **Telemetry event** | A structured event written to the telemetry stream, identifying who emitted it, what happened, and when. |
| **Durable artifact** | A file, record, or checkpoint entry that persists beyond the session and can be independently verified. |
| **Emitter** | Who is responsible for producing the evidence: Foreman, Worker, or Adapter. |

### 3.2 Evidence Table

| Transition | Telemetry Event | Durable Artifact | Emitter |
|---|---|---|---|
| `capability-detected` → `handoff-pending` | `worker-assignment-attempted` or `worker-assigned` | `ChildDispatchRecord` with `worker_assignment.assigned_at`, `assignment_type` | Foreman |
| `capability-detected` → `failed` | `SEAL_INTEGRITY_VIOLATION` audit event | `ChildDispatchRecord.runtime_state: "failed"`; seal violation log | Foreman |
| `handoff-pending` → `acknowledged` | *(none required; acknowledgment IS the evidence)* | Acknowledgment record in checkpoint: `dispatch_id`, `child_id`, `acknowledged_at`, `worker_identity` | Worker |
| `handoff-pending` → `failed` | `worker-assignment-failed` | `ChildDispatchRecord.runtime_state: "failed"` with failure reason | Adapter / Foreman |
| `handoff-pending` → `blocked` | *(Foreman internal; no external event)* | `ChildDispatchRecord.runtime_state: "blocked"` with `blocked_at`, `reason: "launch-timeout"` | Foreman |
| `acknowledged` → `assigned` | *(Foreman writes state; no separate event)* | `ChildDispatchRecord.runtime_state: "assigned"`; acknowledgment record present | Foreman |
| `acknowledged` → `failed` | `worker-result` | CompactReturn at `expected_result_path` with `exit_code != 0`, `error` field | Worker |
| `assigned` → `running` | `worker-heartbeat` | `ChildDispatchRecord.last_heartbeat_at` updated; `runtime_state: "running"` | Worker |
| `assigned` → `blocked` | *(Foreman internal timeout)* | `ChildDispatchRecord.runtime_state: "blocked"` with `blocked_at`, `reason: "launch-timeout"` | Foreman |
| `assigned` → `failed` | `worker-result` | CompactReturn at `expected_result_path` with `exit_code != 0` | Worker |
| `assigned` → `completed` | `worker-result` | CompactReturn at `expected_result_path` with `exit_code: 0`, `status: "success"` | Worker |
| `running` → `blocked` (approval) | `worker-blocked` | `ChildDispatchRecord.runtime_state: "blocked"`; blocker record with `blocker_id`, `reason`, `approval_type` | Worker |
| `running` → `blocked` (stale) | *(Foreman internal timeout)* | `ChildDispatchRecord.runtime_state: "blocked"` with `blocked_at`, `reason: "stale-heartbeat"` | Foreman |
| `running` → `completed` | `worker-result` | CompactReturn at `expected_result_path` with `exit_code: 0` | Worker |
| `running` → `failed` (result) | `worker-result` | CompactReturn at `expected_result_path` with `exit_code != 0`, `error` | Worker |
| `running` → `failed` (rejection) | `worker-rejected` | `ChildDispatchRecord.runtime_state: "failed"` with `rejected_by`, `rejection_reason` | Worker / Operator |
| `running` → `orphaned` | *(Foreman internal timeout)* | `ChildDispatchRecord.runtime_state: "orphaned"` with `orphaned_at` | Foreman |
| `blocked` → `running` | `worker-approved` or `worker-auto-approved`, then `worker-heartbeat` | `ChildDispatchRecord.runtime_state: "running"`; approval record with `blocker_id`, `approved_by` | Operator or Policy, then Worker |
| `blocked` → `completed` | `worker-result` | CompactReturn at `expected_result_path` with `exit_code: 0` | Worker |
| `blocked` → `failed` (rejection) | `worker-rejected` | `ChildDispatchRecord.runtime_state: "failed"` with `rejected_by` | Operator or Policy |
| `blocked` → `failed` (timeout) | *(Foreman internal timeout)* | `ChildDispatchRecord.runtime_state: "failed"` with `reason: "approval-timeout"` | Foreman |
| `blocked` → `orphaned` | *(Foreman internal timeout)* | `ChildDispatchRecord.runtime_state: "orphaned"` with `orphaned_at` | Foreman |

---

## 4. Timeout Configuration

### 4.1 Timeout Parameters

| Parameter | Default | Description |
|---|---|---|
| `launch_to_first_heartbeat_ms` | 30,000 ms (30 s) | Maximum time from dispatch initiation to first heartbeat. Governs `handoff-pending`, `acknowledged`, and `assigned` states. |
| `heartbeat_interval_ms` | 300,000 ms (5 min) | Expected interval between heartbeats during `running` state. Exceeding this triggers `blocked`. |
| `orphan_timeout_ms` | 600,000 ms (10 min) | Maximum time since last telemetry before worker is declared orphaned. Applies in `running` and `blocked` states. |
| `approval_timeout_ms` | 3,600,000 ms (1 hr) | Maximum time waiting for approval in `blocked` (approval sub-case). Expiry triggers `failed`. |

### 4.2 Timeout Ownership

All timeout enforcement is owned by the Foreman. Workers do not self-orphan or self-fail via timeout. The Foreman periodically inspects `last_heartbeat_at` against `now` and drives state transitions when thresholds are exceeded.

---

## 5. Ownership Summary

| State | Primary Owner | Worker Role |
|---|---|---|
| `capability-detected` | Foreman | None |
| `handoff-pending` | Foreman | None |
| `acknowledged` | Foreman (observes); Worker (emits) | Emits acknowledgment |
| `assigned` | Foreman | None |
| `running` | Worker (emits telemetry); Foreman (monitors) | Emits heartbeats |
| `blocked` | Foreman (owns resolution) | Originally emitted block event |
| `completed` | Foreman | Emitted CompactReturn |
| `failed` | Foreman | Emitted CompactReturn or none (timeout-driven) |
| `orphaned` | Foreman | None (silent) |

**Principle:** Workers produce evidence. Foremen act on evidence to drive state transitions. The Foreman owns the lifecycle; workers own their execution output.

---

## 6. Reconciliation with Implementation

### 6.1 State Name Divergence

The implementation in `src/loop/dispatch-state.ts` defines `WorkerDispatchState` with different state names than the canonical names in this spec. The mapping is:

| Canonical Spec State | Implementation State (`WorkerDispatchState`) | Notes |
|---|---|---|
| `capability-detected` | `packet-created` | Same semantic: packet written, worker not yet assigned |
| `handoff-pending` | `delegated` | Partial match: `delegated` in the implementation connotes provider assignment, not just the handoff window |
| `acknowledged` | *(not present)* | **Gap:** The implementation has no explicit acknowledged state |
| `assigned` | `launching` | Partial match: `launching` covers spawn-initiated but not yet confirmed |
| `running` | `running` | Exact match |
| `blocked` | `blocked` and `waiting-for-approval` | The implementation splits blocked into two states; this spec unifies them |
| `completed` | `completed` | Exact match |
| `failed` | `failed` | Exact match |
| `orphaned` | `orphaned` | Exact match |

### 6.2 Transition Graph Divergence

The `isValidTransition()` function in `src/loop/dispatch-state.ts` defines the following graph (using implementation state names):

```
packet-created  → delegated, launching, running
delegated       → launching, running, completed, failed
launching       → running, waiting-for-approval, blocked, completed, failed
running         → waiting-for-approval, blocked, completed, failed
waiting-for-approval → running, completed, failed
blocked         → running, completed, failed, orphaned
```

Comparing with the canonical spec transition graph:

| Canonical Transition | Implementation Transition | Status |
|---|---|---|
| `capability-detected` → `handoff-pending` | `packet-created` → `delegated` | Covered (different names) |
| `capability-detected` → `failed` | `packet-created` → (no direct to failed) | **Gap:** `packet-created` → `failed` is not allowed in implementation |
| `handoff-pending` → `acknowledged` | *(no acknowledged state)* | **Gap:** No acknowledged state in implementation |
| `handoff-pending` → `blocked` | `delegated` → (no blocked) | **Gap:** `delegated` → `blocked` not present in implementation |
| `acknowledged` → `assigned` | *(no acknowledged state)* | **Gap:** Not representable |
| `assigned` → `running` | `launching` → `running` | Covered |
| `assigned` → `blocked` | `launching` → `blocked` | Covered |
| `assigned` → `failed` | `launching` → `failed` | Covered |
| `assigned` → `completed` | `launching` → `completed` | Covered |
| `running` → `blocked` (stale) | `running` → `blocked` | Covered |
| `running` → `blocked` (approval) | `running` → `waiting-for-approval` | Covered (split state) |
| `running` → `completed` | `running` → `completed` | Exact match |
| `running` → `failed` | `running` → `failed` | Exact match |
| `running` → `orphaned` | *(not present)* | **Gap:** `running` → `orphaned` not in `isValidTransition()`; `orphaned` is only reachable from `blocked` in the implementation |
| `blocked` → `running` | `blocked` → `running` | Covered |
| `blocked` → `completed` | `blocked` → `completed` | Covered |
| `blocked` → `failed` | `blocked` → `failed` | Covered |
| `blocked` → `orphaned` | `blocked` → `orphaned` | Exact match |

### 6.3 Dispatch Boundary State Machine

`src/loop/dispatch-boundary.ts` defines a separate `DispatchMachineState` machine with states `idle`, `dispatched`, `worker-running`, `worker-completed`, `checkpointed`, `cluster-complete`, `blocked`, `budget-exhausted`. This is a **Foreman-side orchestration machine**, not a Worker Lifecycle State Machine. It operates at the loop/queue level, not at the per-worker level.

The `ALLOWED_TRANSITIONS` table in `dispatch-boundary.ts` governs the dispatch loop epoch transitions. It does not overlap with the worker lifecycle states in this spec. The two machines are complementary: `dispatch-boundary.ts` governs when dispatches occur; this spec governs what happens inside each dispatch.

### 6.4 Findings Summary

The following gaps require future remediation (source changes are out of scope for POL-213):

| Finding ID | Description | Severity |
|---|---|---|
| F-001 | No explicit `acknowledged` state in the implementation. The acknowledgment-to-assignment transition is implicit. | Medium |
| F-002 | `packet-created` → `failed` is not an allowed transition in `isValidTransition()`, but the spec requires it for seal failure at the pre-handoff stage. | Low |
| F-003 | `running` → `orphaned` is not present in `isValidTransition()`. Workers can only be orphaned from `blocked` in the current implementation, which misses the case where a running worker goes silent without first emitting a blocked event. | Medium |
| F-004 | `delegated` → `blocked` (launch timeout from delegated state) is not modeled in the implementation's transition graph. | Low |
| F-005 | The `waiting-for-approval` state in the implementation is a sub-case of `blocked` in this spec. Future consolidation should consider whether the split adds value or creates confusion. The `deriveDispatchState()` function correctly unifies them under timeout logic, so the split is effectively internal. | Low |
| F-006 | State names in `WorkerDispatchState` (`packet-created`, `delegated`, `launching`) do not match the canonical names in this spec (`capability-detected`, `handoff-pending`, `assigned`). Documentation and tooling that refer to these states by name will need updating if the implementation adopts canonical names. | Low |

---

## 7. Related Specs

- `foreman-worker-architecture.md` — Foreman doctrine, worker doctrine, escalation paths, dispatch modes
- POL-214 — Session contract fields (worker session identity and handoff tokens)
- POL-215 — Telemetry event schemas (event field definitions referenced in §3.2)
