# Worker Telemetry Specification

**Status:** Authoritative spec
**Issue:** POL-215
**Cluster:** POL-211
**Created:** 2026-05-29

---

## Overview

This document is the canonical telemetry event catalog for the Foreman-to-Worker execution contract. It formally specifies all telemetry events emitted during worker dispatch lifecycle, their required and optional fields, the lifecycle state transitions each event drives, and retention and queryability requirements.

The telemetry system must always be able to answer five operational questions:

| Question | Answered by |
|---|---|
| Who owns this child? | `worker-launch`, `worker-acknowledged`, `worker-assigned` |
| Has a worker accepted the work? | `worker-acknowledged` |
| Is the worker alive? | `worker-heartbeat` (recency), `worker-result` |
| Can the session be attached? | `worker-assigned` (`session_id`, `process_pid`) |
| What is the worker currently doing? | `worker-heartbeat` (`step_cursor`, `current_file`) |

### Normative Sources

- `src/loop/dispatch-state.ts` — TypeScript interface definitions (partial implementation)
- `smartdocs/docs/specs/active/worker-lifecycle-state-machine.md` — canonical state machine
- `smartdocs/docs/specs/active/worker-session-contract.md` — session identity field definitions

---

## 1. Base Event Schema

All telemetry events share a common base schema.

```
WorkerTelemetryEventBase {
  event:        string        // Event type discriminator (required)
  event_id:     string        // UUID, unique per event emission (required)
  dispatch_id:  string        // Dispatch event identifier (required)
  run_id:       string        // Polaris run identifier (required)
  child_id:     string        // Child issue identifier, e.g. "POL-215" (required)
  timestamp:    string        // ISO 8601 UTC timestamp (required)
}
```

All fields in `WorkerTelemetryEventBase` are **required** on every event. An event missing any base field MUST be treated as malformed and rejected by the ingestion layer.

---

## 2. Event Catalog

### 2.1 `worker-launch`

**Emitter:** Adapter (process launch layer)

**Purpose:** Signals that a worker process has been started. This is the first telemetry event in the lifecycle for direct-worker and external-process dispatch modes.

**Lifecycle transition driven:**

```
packet-created / delegated  →  launching
```

The Foreman MUST transition the dispatch record to `launching` upon receiving this event if it has not already done so.

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | Resolved provider name. Canonical values: `"copilot"`, `"gemini"`, `"codex"`, `"windsurf"`, `"subagent"` |
| `adapter` | `string` | Adapter module identifier used to launch the worker |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `pid` | `number` | Present when the worker is launched as an OS process. Absent for subagent and remote provider launches |

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id`.

---

### 2.2 `worker-acknowledged`

**Emitter:** Worker

**Purpose:** Confirms the worker has received and validated its assignment packet. This is the canonical signal that a worker entity has accepted ownership of the work. The Foreman uses this event to confirm worker identity and set the acknowledged state.

**Lifecycle transition driven:**

```
launching / handoff-pending  →  acknowledged
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `worker_id` | `string` | Worker's self-reported identity. Must match `ChildDispatchRecord.worker_id` |
| `packet_sha` | `string` | SHA-256 hex digest of the assignment packet read by the worker. Used by the Foreman to verify the correct packet was received |

#### Optional Fields

None. All fields are required.

#### Implementation Gap

**`worker-acknowledged` is not currently emitted by `src/loop/worker.ts`.**

The worker bootstrap code reads the assignment packet but does not emit an acknowledgment event. As a result:

- The Foreman cannot distinguish `launching` from `acknowledged` via telemetry alone.
- `packet_sha` verification cannot be performed.
- The `acknowledged` state in the state machine spec (§1.4 of `worker-lifecycle-state-machine.md`) is never entered via telemetry.

This is a **required implementation gap**. The `worker-acknowledged` event MUST be emitted by the worker immediately after packet validation, before any work output is produced. Until this gap is closed, the Foreman should treat the first `worker-heartbeat` as a proxy for acknowledgment and transition to `running` directly.

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id` and `worker_id`. The `packet_sha` field MUST be queryable to support audit verification.

---

### 2.3 `worker-heartbeat`

**Emitter:** Worker

**Purpose:** Periodic progress signal that proves worker liveness and reports current execution position. This is the primary signal used by the Foreman for health monitoring and orphan detection.

**Lifecycle transition driven:**

```
launching  →  running     (on first heartbeat)
blocked    →  running     (heartbeat received after staleness)
running    →  running     (steady-state, refreshes last_heartbeat_at)
running    →  blocked     (implied, when heartbeat interval expires without a new event)
running    →  orphaned    (implied, when orphan timeout expires)
```

State transitions to `blocked` and `orphaned` are **time-derived** — they are inferred by the Foreman when expected heartbeats are absent, not triggered by an event.

#### Heartbeat Frequency

| Parameter | Default | Description |
|---|---|---|
| `heartbeat_interval_ms` | 300,000 ms (5 min) | Target interval between heartbeats during active work |
| `launch_to_first_heartbeat_ms` | 30,000 ms (30 s) | Maximum time from `worker-launch` to first heartbeat before state degrades to `blocked` |

Workers SHOULD emit heartbeats at least once per `heartbeat_interval_ms`. Workers operating on long-running steps SHOULD emit intermediate heartbeats to reset the staleness clock.

#### Staleness Thresholds

| Condition | Threshold | Resulting State |
|---|---|---|
| Time since last heartbeat > `heartbeat_interval_ms` | 300,000 ms | `blocked` |
| Time since last heartbeat > `orphan_timeout_ms` | 600,000 ms | `orphaned` |
| Time since `worker-launch` with no heartbeat > `launch_to_first_heartbeat_ms` | 30,000 ms | `blocked` |

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `step_cursor` | `string` | Current step label or identifier from the worker's execution plan |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `progress_pct` | `number` (0–100) | Present when the worker can estimate overall completion percentage |
| `current_file` | `string` | Present when the worker is actively reading or modifying a specific file |
| `tokens_used` | `number` | Present when the provider reports token consumption. Cumulative since session start |
| `step_detail` | `string` | Free-form detail text describing the current action within the step |
| `files_changed` | `number` | Count of files modified since dispatch |
| `lines_added` | `number` | Net lines added since dispatch |
| `lines_deleted` | `number` | Net lines deleted since dispatch |
| `provider` | `string` | Provider name, when the worker knows it |
| `model` | `string` | Model identifier in use, when available |
| `elapsed_ms` | `number` | Milliseconds elapsed since worker start |

#### Retention

Retained for the full run lifetime. The most recent heartbeat per `dispatch_id` MUST be queryable. Full heartbeat history SHOULD be retained for audit but may be downsampled for storage efficiency after 30 days. Indexed on `dispatch_id` and `timestamp`.

---

### 2.4 `worker-blocked`

**Emitter:** Worker

**Purpose:** Signals that the worker has paused execution and requires explicit approval before proceeding. This is a voluntary halt — the worker is alive and waiting, not stuck.

**Lifecycle transition driven:**

```
running  →  waiting-for-approval
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `blocker_id` | `string` | Unique identifier for this blocking event. UUID. Used to correlate with approval or rejection events |
| `reason` | `"needs-approval" \| "approval-timeout" \| "error" \| "unknown"` | Reason class for the block |
| `approval_type` | `"destructive" \| "cost" \| "security" \| "ambiguous" \| "external"` | Category of approval required |
| `description` | `string` | Human-readable description of what requires approval and why |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `suggested_action` | `string` | Recommended operator action to unblock |
| `affected_files` | `string[]` | Files that would be modified if approved |
| `command_preview` | `string` | Command to be executed if approved |
| `cost_estimate` | `string` | Estimated cost, for `approval_type: "cost"` |
| `policy_id` | `string` | Policy rule ID that triggered the block |
| `auto_approve_eligible` | `boolean` | Whether this block is eligible for policy auto-approval |

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id` and `blocker_id`.

---

### 2.5 `worker-approved`

**Emitter:** Foreman or Policy engine

**Purpose:** Grants approval for a blocked worker to continue. The Foreman forwards this event to the worker's execution context via the approval channel.

**Lifecycle transition driven:**

```
waiting-for-approval  →  running
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `blocker_id` | `string` | Must match a `blocker_id` from a preceding `worker-blocked` event on the same `dispatch_id` |
| `approved_by` | `"operator" \| "policy"` | Source of the approval decision |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `operator_id` | `string` | Present when `approved_by` is `"operator"`. Identifies the human approver |
| `policy_applied` | `string` | Present when `approved_by` is `"policy"`. Identifies the policy rule |

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id` and `blocker_id`. The `approved_by` and `operator_id` fields MUST be queryable for audit purposes.

---

### 2.6 `worker-rejected`

**Emitter:** Foreman or Policy engine

**Purpose:** Denies a blocked worker's approval request. The worker MUST treat rejection as a terminal signal and emit `worker-result` with `status: "failure"`.

**Lifecycle transition driven:**

```
waiting-for-approval  →  failed
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `blocker_id` | `string` | Must match a `blocker_id` from a preceding `worker-blocked` event on the same `dispatch_id` |
| `rejected_by` | `"operator" \| "policy" \| "timeout"` | Source of the rejection. `"timeout"` is used when `approval_timeout_ms` expires without a decision |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `operator_id` | `string` | Present when `rejected_by` is `"operator"` |
| `rejection_reason` | `string` | Human-readable reason for rejection |

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id` and `blocker_id`. The `rejected_by` and `rejection_reason` fields MUST be queryable for audit purposes.

---

### 2.7 `worker-result`

**Emitter:** Worker

**Purpose:** Terminal event signaling that the worker has completed execution. This is the definitive completion signal. The Foreman MUST transition to a terminal state upon receiving this event regardless of prior state.

**Lifecycle transition driven:**

```
running / waiting-for-approval / blocked  →  completed   (when status = "success")
running / waiting-for-approval / blocked  →  failed      (when status = "failure" or "blocked")
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `status` | `"success" \| "failure" \| "blocked"` | Terminal outcome. `"blocked"` indicates the worker stopped due to an unresolved block with no approval path |
| `exit_code` | `number` | Process or session exit code. `0` for success, non-zero for failure |
| `step_cursor` | `string` | Final step position at the time of termination |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `result_file` | `string` | Path to the result artifact file, when the worker produced structured output |
| `compact_return` | `object` | Inline result summary for lightweight delivery without a result file |
| `error_message` | `string` | Present when `status` is `"failure"` or `"blocked"`. Human-readable error description |

#### Retention

Retained for the full run lifetime and beyond (result events are part of the permanent run record). Indexed on `dispatch_id`, `status`, and `timestamp`.

---

### 2.8 `worker-assignment-attempted`

**Emitter:** Foreman

**Purpose:** Records that the Foreman has begun the process of assigning a worker. Emitted before the assignment outcome is known.

**Lifecycle transition driven:**

```
packet-created / delegated  →  delegated   (or remains in pre-launch)
```

This event records intent; it does not confirm success. The `worker-assigned` or `worker-assignment-failed` event provides the outcome.

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `assignment_type` | `"subagent" \| "external-process" \| "human-handoff"` | Mechanism being attempted |

#### Optional Fields

None.

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id`.

---

### 2.9 `worker-assigned`

**Emitter:** Foreman

**Purpose:** Confirms that a worker has been successfully assigned. Provides the session or process identity needed for attachment.

**Lifecycle transition driven:**

```
delegated  →  launching
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `assignment_type` | `"subagent" \| "external-process" \| "human-handoff"` | Mechanism that succeeded |

#### Optional Fields

| Field | Type | Condition |
|---|---|---|
| `session_id` | `string` | Present when `assignment_type` is `"subagent"` and the provider returns a session identifier. This is the primary attachment handle for subagent workers |
| `process_pid` | `number` | Present when `assignment_type` is `"external-process"`. OS process ID of the spawned worker |
| `handoff_token` | `string` | Present when `assignment_type` is `"human-handoff"`. Opaque token used to resume the handoff |

#### Retention

Retained for the full run lifetime. The `session_id` and `process_pid` fields MUST be queryable to support session attachment. Indexed on `dispatch_id`.

---

### 2.10 `worker-assignment-failed`

**Emitter:** Foreman

**Purpose:** Records that an assignment attempt failed. The Foreman may retry with a different mechanism or escalate.

**Lifecycle transition driven:**

```
delegated  →  failed          (if no retry path exists)
delegated  →  delegated       (if Foreman retries with another mechanism)
```

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `reason` | `"no-subagent-support" \| "process-spawn-failed" \| "provider-unavailable" \| "timeout"` | Failure classification |

#### Optional Fields

None.

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id`.

---

### 2.11 `escalation-initiated`

**Emitter:** Foreman

**Purpose:** Signals that all automatic assignment mechanisms have been exhausted and human intervention is required. This event does not transition to a terminal state — it is an advisory event that leaves the dispatch in a `blocked` state pending human action.

**Lifecycle transition driven:**

```
delegated  →  blocked    (advisory; no automatic work can proceed)
```

The `blocked` state in this context indicates the dispatch cannot proceed automatically. A human can still manually dispatch to resolve it.

#### Required Fields

| Field | Type | Description |
|---|---|---|
| `reason` | `string` | Free-form description of why escalation was necessary |
| `recommended_action` | `"manual-dispatch" \| "provider-config" \| "subagent-enable"` | Recommended operator action |

#### Optional Fields

None.

#### Retention

Retained for the full run lifetime. Indexed on `dispatch_id`. Escalation events MUST be queryable by run for operational dashboards.

---

## 3. State Machine Transition Table

The following table maps each event to the state transition it drives. Time-derived transitions (no event trigger) are marked with an asterisk.

| Event | Pre-State(s) | Post-State | Notes |
|---|---|---|---|
| `worker-assignment-attempted` | `packet-created`, `delegated` | `delegated` | Intent only; no outcome implied |
| `worker-assigned` | `delegated` | `launching` | Session/PID identity now available |
| `worker-assignment-failed` | `delegated` | `failed` or `delegated` | Retry possible |
| `escalation-initiated` | `delegated` | `blocked` | Advisory; human action needed |
| `worker-launch` | `packet-created`, `delegated` | `launching` | Process started |
| `worker-acknowledged` | `launching`, `handoff-pending` | `acknowledged` | Worker identity confirmed |
| `worker-heartbeat` (first) | `launching`, `acknowledged` | `running` | Worker active |
| `worker-heartbeat` (subsequent) | `running`, `blocked` | `running` | Liveness refresh |
| *(heartbeat interval expires)* | `running` | `blocked` | No heartbeat for 5 min |
| *(orphan timeout expires)* | `running`, `blocked` | `orphaned` | No heartbeat for 10 min |
| `worker-blocked` | `running` | `waiting-for-approval` | Voluntary pause |
| `worker-approved` | `waiting-for-approval` | `running` | Work may resume |
| `worker-rejected` | `waiting-for-approval` | `failed` | Work terminated |
| *(approval timeout)* | `waiting-for-approval` | `failed` | No decision for 1 hour |
| `worker-result` (success) | any active | `completed` | Terminal |
| `worker-result` (failure/blocked) | any active | `failed` | Terminal |

---

## 4. Lifecycle Coverage Map

The five operational questions map to events as follows:

| Question | Primary Event | Secondary Event |
|---|---|---|
| Who owns this child? | `worker-acknowledged` (`worker_id`) | `worker-assigned` (`session_id`) |
| Has a worker accepted the work? | `worker-acknowledged` | *(first `worker-heartbeat` as proxy until gap closed)* |
| Is the worker alive? | `worker-heartbeat` (recency check) | `worker-result` (terminal) |
| Can the session be attached? | `worker-assigned` (`session_id`, `process_pid`) | `worker-launch` (`pid`) |
| What is the worker currently doing? | `worker-heartbeat` (`step_cursor`, `current_file`) | — |

---

## 5. Implementation Gaps

### 5.1 `worker-acknowledged` Not Emitted

**Severity:** Required

`src/loop/worker.ts` does not currently emit `worker-acknowledged`. As a result:

- The `acknowledged` state is unreachable via telemetry.
- Worker identity (`worker_id`) and packet integrity (`packet_sha`) cannot be verified at acknowledgment time.
- The Foreman has no way to distinguish a worker that received the wrong packet from one that received the correct packet.

**Interim behavior:** Until this gap is closed, the Foreman SHOULD treat the first `worker-heartbeat` as the acknowledgment proxy and transition directly to `running`. This behavior MUST be documented in the Foreman's state derivation logic and removed once `worker-acknowledged` is implemented.

**Remediation:** The worker bootstrap sequence in `src/loop/worker.ts` must be updated to emit `worker-acknowledged` immediately after packet read and SHA validation, before any work output.

---

## 6. Retention and Queryability Summary

| Event | Retention Period | Required Queryable Fields |
|---|---|---|
| `worker-launch` | Full run lifetime | `dispatch_id` |
| `worker-acknowledged` | Full run lifetime | `dispatch_id`, `worker_id`, `packet_sha` |
| `worker-heartbeat` | Full run lifetime (may downsample after 30 days) | `dispatch_id`, `timestamp` (most recent must be fast) |
| `worker-blocked` | Full run lifetime | `dispatch_id`, `blocker_id` |
| `worker-approved` | Full run lifetime | `dispatch_id`, `blocker_id`, `approved_by`, `operator_id` |
| `worker-rejected` | Full run lifetime | `dispatch_id`, `blocker_id`, `rejected_by` |
| `worker-result` | Permanent (part of run record) | `dispatch_id`, `status`, `timestamp` |
| `worker-assignment-attempted` | Full run lifetime | `dispatch_id` |
| `worker-assigned` | Full run lifetime | `dispatch_id`, `session_id`, `process_pid` |
| `worker-assignment-failed` | Full run lifetime | `dispatch_id` |
| `escalation-initiated` | Full run lifetime | `dispatch_id`, `run_id` |

**"Full run lifetime"** means the event is retained until the Polaris run record is archived or deleted. Events in terminal dispatch records are retained with the run record for the same period.

---

## 7. Timeout Reference

Default values from `src/loop/dispatch-state.ts` (`DEFAULT_TIMEOUTS`):

| Parameter | Default Value | Purpose |
|---|---|---|
| `launch_to_first_heartbeat_ms` | 30,000 ms (30 s) | Time from `worker-launch` to first `worker-heartbeat` before `blocked` |
| `heartbeat_interval_ms` | 300,000 ms (5 min) | Expected interval between heartbeats; expiry → `blocked` |
| `orphan_timeout_ms` | 600,000 ms (10 min) | Time since last heartbeat before `orphaned` |
| `approval_timeout_ms` | 3,600,000 ms (1 hr) | Time in `waiting-for-approval` before auto-fail |

These values are configurable via `WorkerTimeoutConfig`. The Foreman MUST apply these thresholds to derive time-based state transitions in `deriveDispatchState`.
