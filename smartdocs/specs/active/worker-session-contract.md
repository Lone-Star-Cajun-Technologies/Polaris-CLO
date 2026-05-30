---
kind: spec
status: active
source: POL-214
created: 2026-05-29
implements: 
related: smartdocs/docs/specs/active/worker-lifecycle-state-machine.md
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: src/loop/dispatch-state.ts
---

# Worker Session Contract Spec

**Status:** Authoritative session contract spec  
**Issue:** POL-214  
**Cluster:** POL-211  
**Created:** 2026-05-29

---

## Overview

This document defines the canonical session model that Polaris must store per worker dispatch. The contract is designed to capture all identity, ownership, heartbeat, and capability fields today — in their final form — so that future Connect features (provider-level session attachment, remote monitoring, live telemetry) can be enabled through feature flags without requiring schema migrations.

All fields defined here are part of the stable contract. Fields marked **[gap]** are required by this spec but absent from the current `ChildDispatchRecord` schema as of the POL-211 analysis (see §6).

---

## 1. Session Identity Fields

These fields uniquely identify a worker session within the Polaris runtime.

### 1.1 `worker_id`

| Property | Value |
|---|---|
| **Type** | `string` (UUID or equivalent opaque ID) |
| **Required** | Yes |
| **Owner** | Foreman |
| **Set by** | Foreman, at dispatch time, before packet emission |
| **Cleared** | Never — `worker_id` is immutable once assigned |
| **Archived** | Retained in dispatch evidence for the full run lifetime |

**Definition:** A unique identifier assigned to this particular dispatch event. `worker_id` is distinct from `dispatch_id` in that it refers to the logical worker entity, while `dispatch_id` refers to the dispatch event. In practice for single-attempt dispatches, these often share the same value, but they MUST be treated as separate fields to accommodate re-dispatch (where a new `dispatch_id` is issued but the `worker_id` may be reassigned or carried forward depending on provider semantics).

**Relationship to `ChildDispatchRecord.dispatch_id`:** `dispatch_id` is the event key — it identifies a specific dispatch invocation. `worker_id` is the entity key — it identifies the worker executing the work. In a first-dispatch scenario, `worker_id = dispatch_id` is an acceptable initialization. On re-dispatch, a new `dispatch_id` is always issued; `worker_id` MAY be retained when the same worker session is resumed (provider-dependent resume semantics).

**Canonical name:** `worker_id`  
**Storage location:** `ChildDispatchRecord` (see §1.5 for full record spec)

---

### 1.2 `session_id`

| Property | Value |
|---|---|
| **Type** | `string \| null` |
| **Required** | No (may be null in delegated mode) |
| **Owner** | Provider adapter (set after session establishment) |
| **Set by** | Provider adapter, after the provider session is established |
| **Cleared** | Set to `null` if session establishment fails; not cleared otherwise |
| **Archived** | Retained in dispatch evidence |

**Definition:** The provider-assigned session identifier. This is the session token or ID returned by the provider when a worker session is started. For Claude Code subagent dispatch, this is the subagent's session ID (equivalent to `WorkerAssignmentRecord.subagent_session_id`). For external CLI providers (Gemini, Codex), this may be a process UUID or provider-assigned invocation ID. For Copilot, this is the agent session token.

**Null semantics:** `session_id` is null when:
- `dispatch_mode` is `"delegated"` and the assignment has not yet been acknowledged (pre-acknowledgment state).
- The provider does not issue session IDs (e.g., fire-and-forget external processes that do not report back an ID).

A null `session_id` does not indicate failure. The Foreman MUST NOT treat a null `session_id` as an error unless the provider's adapter contract requires session IDs.

**Canonical name:** `session_id`  
**Storage location:** `ChildDispatchRecord`  
**[gap]** Field is absent from current `ChildDispatchRecord` schema.

---

### 1.3 `provider`

| Property | Value |
|---|---|
| **Type** | `string \| undefined` |
| **Required** | Conditional — required when `dispatch_mode` is `"direct-worker"` |
| **Owner** | Foreman |
| **Set by** | Foreman, at dispatch time, from the child's resolved provider definition |
| **Cleared** | Never — immutable once set |
| **Archived** | Retained in dispatch evidence |

**Definition:** The resolved provider name for this dispatch. Canonical values are `"copilot"`, `"gemini"`, `"codex"`, `"windsurf"`, or `"subagent"` (for internal delegated dispatch). The `"subagent"` value is used when `dispatch_mode` is `"delegated"` and the assignment mechanism is `"subagent"`. Other delegated mechanisms (`"external-process"`, `"human-handoff"`) do not populate `provider`.

**Resolution rules:**
1. If the child definition includes an explicit `provider` annotation, use that value verbatim.
2. If `dispatch_mode` is `"delegated"` and `assignment_type` is `"subagent"`, set `provider` to `"subagent"`.
3. Otherwise, leave `provider` undefined (not null — omit the field).

**Canonical name:** `provider`  
**Storage location:** `ChildDispatchRecord` (field already present; semantics formalized here)

---

### 1.4 `dispatch_id`

| Property | Value |
|---|---|
| **Type** | `string` (UUID or equivalent) |
| **Required** | Yes |
| **Owner** | Foreman |
| **Set by** | Foreman, at dispatch time |
| **Cleared** | Never |
| **Archived** | Retained in dispatch evidence |

**Definition:** The unique identifier for this dispatch event. Already present in `ChildDispatchRecord`. This spec formalizes its relationship to `worker_id` and `session_id`.

- `dispatch_id` is event-scoped: one per dispatch invocation.
- A re-dispatch of the same child issues a new `dispatch_id`.
- The `dispatch_id` appears in heartbeat events, acknowledgments, and the CompactReturn to provide end-to-end correlation.
- In `LoopState.open_children_meta[child_id].dispatch_record`, the `dispatch_id` serves as the correlation key between the checkpoint record and all runtime events.

**Canonical name:** `dispatch_id`  
**Storage location:** `ChildDispatchRecord` (field already present)

---

### 1.5 Canonical `ChildDispatchRecord` Session Fields Summary

The following table defines the full set of session identity fields as they MUST appear in `ChildDispatchRecord`. Fields marked **[existing]** are already in the schema; fields marked **[gap]** are required by this contract but currently absent.

| Field | Type | Required | Owner | Status |
|---|---|---|---|---|
| `dispatch_id` | `string` | Yes | Foreman | [existing] |
| `worker_id` | `string` | Yes | Foreman | **[gap]** |
| `session_id` | `string \| null` | No | Adapter | **[gap]** |
| `provider` | `string \| undefined` | Conditional | Foreman | [existing] |
| `child_id` | `string` | Yes | Foreman | [existing] |
| `run_id` | `string` | Yes | Foreman | [existing] |
| `cluster_id` | `string` | Yes | Foreman | [existing] |
| `dispatch_mode` | `DispatchMode` | Yes | Foreman | [existing] |
| `dispatched_at` | `string` (ISO 8601) | Yes | Foreman | [existing] |
| `runtime_state` | `WorkerRuntimeState` | Yes | Foreman | [existing] |
| `attachment_capable` | `boolean` | Yes | Adapter | **[gap]** |

---

## 2. Ownership and Lifecycle Rules

### 2.1 Field Ownership Matrix

| Field | Created by | Updated by | Read by | Immutable after |
|---|---|---|---|---|
| `dispatch_id` | Foreman | — | Worker, Adapter, Auditor | Creation |
| `worker_id` | Foreman | — | Worker, Adapter, Auditor | Creation |
| `session_id` | Adapter | Adapter (on session start) | Foreman, Auditor | Session establishment |
| `provider` | Foreman | — | Worker, Adapter, Auditor | Creation |
| `runtime_state` | Foreman | Foreman (from heartbeat/CompactReturn) | All | — (mutable throughout lifecycle) |
| `last_heartbeat_at` | Foreman (from worker telemetry) | Foreman | Foreman, Auditor | — (mutable) |
| `last_heartbeat_step` | Foreman (from worker telemetry) | Foreman | Foreman, Auditor | — (mutable) |
| `attachment_capable` | Adapter | — | Foreman, Connect | After first dispatch |

### 2.2 Lifecycle Phases

**Phase 1 — Packet Creation (`runtime_state: "packet-created"`)**

The Foreman:
1. Generates `dispatch_id` (UUID).
2. Generates `worker_id` (UUID; may equal `dispatch_id` for first dispatch).
3. Sets `provider` from child definition.
4. Sets `session_id` to `null` (provider not yet contacted).
5. Sets `attachment_capable` to `false` (provider not yet resolved).
6. Writes `ChildDispatchRecord` to checkpoint before any dispatch action.

**Phase 2 — Dispatch (`runtime_state: "delegated"` or `"launching"`)**

The adapter:
1. Contacts the provider (spawns subagent, invokes CLI, calls API).
2. Receives `session_id` from the provider on successful session establishment.
3. Writes `session_id` to the dispatch record.
4. Sets `attachment_capable` based on provider capability (see §4).
5. Foreman updates `runtime_state` to `"running"` upon acknowledgment receipt.

**Phase 3 — Execution (`runtime_state: "running"`)**

- Worker emits heartbeats; Foreman updates `last_heartbeat_at` and `last_heartbeat_step`.
- `session_id`, `worker_id`, `dispatch_id` are frozen.
- `attachment_capable` is frozen.
- `runtime_state` may advance to `"waiting-for-approval"`, `"blocked"`, etc.

**Phase 4 — Completion (`runtime_state: "completed"` or `"failed"` or `"orphaned"`)**

- Foreman receives CompactReturn and updates `runtime_state` to terminal state.
- The dispatch record is archived to `completed_children_meta` (or equivalent).
- No fields are cleared. All session identity fields are retained for audit purposes.

**Phase 5 — Archive**

- The completed dispatch record is retained in the run's artifact directory.
- Retained fields enable post-run auditing, Connect replay, and telemetry correlation.

### 2.3 Re-dispatch Semantics

When a child is re-dispatched after a `"failed"` or `"orphaned"` state:

1. The Foreman issues a **new** `dispatch_id`.
2. The Foreman MAY retain the prior `worker_id` if the same worker session is resumed, or issue a new `worker_id` if a new session is started. This is provider-dependent.
3. `session_id` is reset to `null`.
4. `attachment_capable` is reset to `false` pending new provider resolution.
5. The prior dispatch record is archived as `previous_dispatch_record` (nested) before being replaced.
6. `runtime_state` is reset to `"packet-created"`.

The prior `dispatch_id` and `session_id` MUST NOT be reused. This enforces that each dispatch event is independently auditable. The `worker_id` retention behavior allows providers with stable session semantics to maintain worker continuity across re-dispatches when appropriate.

---

## 3. Heartbeat Tracking

### 3.1 Required Heartbeat Fields on `ChildDispatchRecord`

The following heartbeat fields MUST be present on `ChildDispatchRecord`:

| Field | Type | Required | Status |
|---|---|---|---|
| `last_heartbeat_at` | `string \| undefined` (ISO 8601) | No (absent before first heartbeat) | [existing] |
| `last_heartbeat_step` | `string \| undefined` | No (absent before first heartbeat) | [existing] |
| `heartbeat_count` | `number \| undefined` | No | **[gap]** |
| `first_heartbeat_at` | `string \| undefined` (ISO 8601) | No | **[gap]** |

**`heartbeat_count`** — The total number of heartbeats received from this worker during this dispatch. Used to detect heartbeat gaps (e.g., count stalls while `last_heartbeat_at` is recent).

**`first_heartbeat_at`** — The timestamp of the first heartbeat received. Used to compute time-to-first-heartbeat, a dispatch quality metric.

### 3.2 Foreman Update Procedure

When the Foreman receives a heartbeat from a worker:

1. Parse the heartbeat payload (see §3.3 for required fields).
2. Validate that `heartbeat.dispatch_id` matches the active `ChildDispatchRecord.dispatch_id`. Reject mismatched heartbeats and log a `HEARTBEAT_DISPATCH_ID_MISMATCH` audit event.
3. Update `ChildDispatchRecord`:
   - Set `last_heartbeat_at` to `heartbeat.timestamp`.
   - Set `last_heartbeat_step` to `heartbeat.step`.
   - Increment `heartbeat_count` by 1.
   - If `first_heartbeat_at` is not set, set it to `heartbeat.timestamp`.
4. Write the updated record to checkpoint atomically.
5. If `heartbeat.runtime_state` differs from the current `ChildDispatchRecord.runtime_state`, update `runtime_state` (subject to valid state transition rules).

### 3.3 Heartbeat Payload Fields

A valid heartbeat MUST contain:

| Field | Type | Required | Description |
|---|---|---|---|
| `dispatch_id` | `string` | Yes | Must match active dispatch |
| `worker_id` | `string` | Yes | Must match active worker |
| `child_id` | `string` | Yes | Must match dispatched child |
| `run_id` | `string` | Yes | Must match active run |
| `timestamp` | `string` (ISO 8601) | Yes | Monotonic timestamp of heartbeat |
| `step` | `string` | Yes | Human-readable description of current step |
| `runtime_state` | `WorkerRuntimeState` | Yes | Worker's reported runtime state |
| `progress_pct` | `number \| undefined` | No | 0–100 progress estimate |
| `session_id` | `string \| null \| undefined` | No | May be used to populate session_id if not yet set |

### 3.4 Staleness Thresholds

Thresholds are derived from the canonical telemetry constants defined in `worker-telemetry-spec.md`:

| Threshold | Value | Action |
|---|---|---|
| **Heartbeat frequency** | Minimum once every 300,000 ms (5 min) during active execution | Worker requirement (from `heartbeat_interval_ms`) |
| **Staleness warning** | 225 seconds (escalation * 0.75) since `last_heartbeat_at` | Foreman logs `HEARTBEAT_STALE_WARNING` audit event; no state change |
| **Staleness escalation** | 300,000 ms (5 min) since `last_heartbeat_at` | Foreman sets `runtime_state: "blocked"` (from `heartbeat_interval_ms`) |
| **Orphan timeout** | 600,000 ms (10 min) since `last_heartbeat_at` | Foreman sets `runtime_state: "orphaned"` and escalates (from `orphan_timeout_ms`) |
| **Post-dispatch timeout** | 30,000 ms (30 s) since `dispatched_at` with no `first_heartbeat_at` | Treated as dispatch failure; Foreman escalates (from `launch_to_first_heartbeat_ms`) |

**Threshold override:** Provider adapters may declare a `heartbeat_timeout_override_seconds` to extend the staleness escalation threshold. This is used for providers that do not support heartbeat emission (e.g., Gemini CLI, Codex CLI), where the Foreman uses a fixed completion timeout instead. When `heartbeat_timeout_override_seconds` is set, it replaces the escalation threshold and the warning threshold becomes `override * 0.75`.

---

## 4. Attachment Capability

### 4.1 `attachment_capable` Field Definition

| Property | Value |
|---|---|
| **Field name** | `attachment_capable` |
| **Type** | `boolean` |
| **Required** | Yes (always present on `ChildDispatchRecord`) |
| **Default** | `false` |
| **Owner** | Provider adapter |
| **Set by** | Provider adapter, after provider capability is resolved |
| **Immutable after** | First dispatch (set once, not updated during execution) |
| **Storage location** | `ChildDispatchRecord` |

**Definition:** `attachment_capable` indicates whether the provider session established for this dispatch supports the Connect attachment protocol. This is a **provider capability flag**, not a runtime state flag. It reflects what the provider can do, not what is currently happening.

### 4.2 When `attachment_capable` is `true`

`attachment_capable` is set to `true` when all of the following hold:

1. The provider has an active session with a stable `session_id`.
2. The provider's adapter declares `supports_attachment: true` in the provider capability registry.
3. The session was established with an attachment-capable invocation mode (e.g., not a fire-and-forget CLI invocation).
4. The `session_id` is non-null and non-empty.

Providers that currently support attachment (when Connect is implemented):

| Provider | `attachment_capable` |
|---|---|
| `subagent` | `true` (subagent session ID is always available) |
| `copilot` | `true` (agent session token available) |
| `gemini` | `false` (CLI invocation; no persistent session) |
| `codex` | `false` (CLI invocation; no persistent session) |
| `windsurf` | `true` (Cascade session supports attachment) |
| `external-process` | `false` (process PID only; no session protocol) |
| `human-handoff` | `false` (no automated attachment) |
| `pending-escalation` | `false` |

### 4.3 When `attachment_capable` is `false`

`attachment_capable` is `false` when:
- The provider does not support persistent sessions.
- The session was not established with attachment-capable invocation parameters.
- `session_id` is null (provider session not yet established or not available).
- The provider is in a mode that does not expose session attachment (e.g., Gemini CLI).

A `false` value does not indicate failure. It indicates that Connect attachment is not available for this session. Polaris must degrade gracefully: heartbeat polling and CompactReturn file watching serve as the fallback monitoring mechanism.

### 4.4 What Polaris Must Store for Future Connect Attachment

To enable Connect attachment without schema migration, the following fields MUST be stored today:

| Field | Purpose |
|---|---|
| `session_id` | The provider session token that Connect uses to attach |
| `worker_id` | Correlates the Connect session to the Polaris dispatch record |
| `attachment_capable` | Gate: Connect only attempts attachment when `true` |
| `provider` | Determines which Connect adapter to use |
| `dispatch_id` | Correlation key for all events during the session |
| `dispatched_at` | Connect uses this to validate session recency |
| `run_id` | Associates the attached session with the active run |
| `cluster_id` | Associates the attached session with the cluster |

Connect feature flags will gate the attachment behavior at runtime. No schema changes are required if all eight fields above are present.

---

## 5. Field Ordering and Canonical Schema

The following is the canonical `ChildDispatchRecord` schema as defined by this contract. Fields are ordered by lifecycle phase (creation → dispatch → runtime → capability).

```typescript
interface ChildDispatchRecord {
  // --- Identity (set at packet-created, immutable) ---
  dispatch_id: string;           // [existing] Unique dispatch event ID
  worker_id: string;             // [gap] Unique worker entity ID
  child_id: string;              // [existing] Child issue being executed
  run_id: string;                // [existing] Active run
  cluster_id: string;            // [existing] Active cluster
  packet_path: string;           // [existing] Path to packet file
  expected_result_path: string;  // [existing] Path for CompactReturn
  dispatched_at: string;         // [existing] ISO 8601 dispatch timestamp
  dispatch_mode: DispatchMode;   // [existing] "delegated" | "direct-worker"

  // --- Provider (set at packet-created or dispatch phase) ---
  provider?: string;             // [existing] Resolved provider name
  session_id: string | null;     // [gap] Provider-assigned session ID

  // --- Capability (set at dispatch phase, immutable after) ---
  attachment_capable: boolean;   // [gap] Provider supports Connect attachment

  // --- Runtime state (mutable throughout lifecycle) ---
  runtime_state?: WorkerRuntimeState; // [existing]
  status: "dispatched" | "completed" | "failed"; // [existing] (legacy; superseded by runtime_state)

  // --- Heartbeat (updated by Foreman from worker telemetry) ---
  last_heartbeat_at?: string;    // [existing] ISO 8601
  last_heartbeat_step?: string;  // [existing]
  heartbeat_count?: number;      // [gap] Total heartbeats received
  first_heartbeat_at?: string;   // [gap] ISO 8601 first heartbeat timestamp

  // --- Assignment (delegated mode) ---
  worker_assignment?: WorkerAssignmentRecord; // [existing]
}
```

---

## 6. Gap Analysis vs Current Schema

This section compares the fields defined in this spec against the current `ChildDispatchRecord` interface in `src/loop/checkpoint.ts`.

### 6.1 Summary

| Field | Spec Requirement | Current Schema | Gap |
|---|---|---|---|
| `dispatch_id` | Required | Present | None |
| `worker_id` | Required | **Absent** | **Yes** |
| `session_id` | Required (nullable) | **Absent** | **Yes** |
| `provider` | Conditional | Present | None |
| `child_id` | Required | Present | None |
| `run_id` | Required | Present | None |
| `cluster_id` | Required | Present | None |
| `packet_path` | Required | Present | None |
| `expected_result_path` | Required | Present | None |
| `dispatched_at` | Required | Present | None |
| `dispatch_mode` | Required | Present (optional in schema) | Minor — should be required |
| `runtime_state` | Required | Present (optional in schema) | Minor — should be required |
| `attachment_capable` | Required | **Absent** | **Yes** |
| `last_heartbeat_at` | Required (optional pre-heartbeat) | Present (optional) | None |
| `last_heartbeat_step` | Required (optional pre-heartbeat) | Present (optional) | None |
| `heartbeat_count` | Optional | **Absent** | **Yes** |
| `first_heartbeat_at` | Optional | **Absent** | **Yes** |
| `worker_assignment` | Required for delegated | Present (optional) | None |
| `status` | Present (legacy) | Present | None (legacy field retained) |

### 6.2 Implementation Gaps (fields to add)

The following fields are required by this spec but absent from the current `ChildDispatchRecord` in `src/loop/checkpoint.ts`:

**Gap 1: `worker_id: string`**  
- Required for session identity and Connect attachment.
- Should be added as a required field alongside `dispatch_id`.
- For backward compatibility with existing records, treat absence as `worker_id = dispatch_id`.

**Gap 2: `session_id: string | null`**  
- Required for Connect attachment and provider session correlation.
- Should default to `null` at packet creation.
- Set by adapter after provider session establishment.

**Gap 3: `attachment_capable: boolean`**  
- Required for Connect feature flag gating.
- Should default to `false`.
- Set by adapter after provider capability is resolved.

**Gap 4: `heartbeat_count: number`**  
- Optional quality metric.
- Should default to `0`.
- Incremented by Foreman on each heartbeat receipt.

**Gap 5: `first_heartbeat_at: string`**  
- Optional quality metric.
- Set by Foreman on first heartbeat receipt.

### 6.3 Schema Strictness Gaps

The following existing fields are typed as optional in the current schema but MUST be treated as required per this contract:

| Field | Current Schema | Contract Requirement |
|---|---|---|
| `dispatch_mode` | `DispatchMode \| undefined` | Required — every dispatch must have a mode |
| `runtime_state` | `WorkerRuntimeState \| undefined` | Required — every dispatch must have an initial state |

These are not breaking changes. Existing records that omit these fields (written before this spec) MUST be treated by readers as:
- `dispatch_mode` absent → treat as `"delegated"` (safe default)
- `runtime_state` absent → treat as `"packet-created"` (safe default)

### 6.4 LoopState Gaps

The `LoopState` interface does not directly store session identity — it delegates to `ChildDispatchRecord` via `open_children_meta[child_id].dispatch_record`. No gaps exist at the `LoopState` level; all session fields are correctly scoped to the dispatch record.

The `WorkerAssignmentRecord.subagent_session_id` field partially overlaps with the new `session_id` field. The canonical behavior after this spec:
- `session_id` is the top-level provider-agnostic session identifier.
- `worker_assignment.subagent_session_id` is retained for backward compatibility but is considered a redundant (derived) field for subagent dispatches.
- For new code, `session_id` is the authoritative source; `subagent_session_id` is populated for legacy compatibility only.

---

## 7. Invariants

| Invariant | Description |
|---|---|
| **`worker_id` persistence** | `worker_id` MAY be retained across re-dispatches when the same worker session is resumed (provider-dependent). |
| **`session_id` null-safety** | A null `session_id` is valid and must not be treated as an error. |
| **`attachment_capable` gating** | Connect attachment is only attempted when `attachment_capable: true` AND `session_id` is non-null. |
| **Heartbeat-dispatch correlation** | Heartbeats with mismatched `dispatch_id` are rejected. |
| **Re-dispatch isolation** | Re-dispatch always issues new `dispatch_id` and `worker_id`. Previous records are archived, not overwritten. |
| **No session_id reuse** | A `session_id` from a prior dispatch MUST NOT be reused for a re-dispatch. |
| **Foreman owns identity fields** | Only the Foreman sets `dispatch_id`, `worker_id`, and `provider`. Adapters set `session_id` and `attachment_capable`. Workers set neither. |

---

## 8. Related Specs

- `foreman-worker-architecture.md` — Foreman and worker roles, dispatch modes, escalation paths
- `worker-lifecycle-state-machine.md` — State transitions for `WorkerRuntimeState` (POL-213)
- `worker-telemetry-spec.md` — Heartbeat and event schema definitions (POL-215)
- `current-state-schema.md` — Run state schema reference
