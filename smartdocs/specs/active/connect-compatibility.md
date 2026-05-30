---
kind: spec
status: active
source: POL-216
created: 2026-05-29
implements: 
related: smartdocs/docs/specs/active/worker-session-contract.md,smartdocs/docs/specs/active/worker-lifecycle-state-machine.md,smartdocs/docs/specs/active/worker-telemetry-spec.md
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: src/loop/dispatch-state.ts,src/loop/dispatch-boundary.ts
---

# Connect Compatibility Specification

**Status:** Authoritative  
**Issue:** POL-216  
**Cluster:** POL-211  
**Created:** 2026-05-29  
**Related specs:** `worker-session-contract.md` (POL-214), `worker-lifecycle-state-machine.md` (POL-213), `worker-telemetry-spec.md` (POL-215)

---

## Overview

This specification defines what the Polaris runtime must store **today** to enable EVOconnect integration features through feature flags in the future — without requiring schema migrations.

EVOconnect ("Connect") is a future operator-facing UI that will provide live visibility into, and control over, running Polaris worker sessions. This spec is design-forward: it describes the session model Polaris must establish now so that Connect features can be enabled incrementally, each gated by a feature flag, with zero migration cost at the time of enablement.

No Connect implementation is performed here. No source code is modified. This document covers the Polaris/Connect boundary for each planned Connect feature, the storage commitments Polaris must make today, and a gap analysis against the current checkpoint schema.

---

## 1. Connect Features and Polaris/Connect Boundaries

### 1.1 Live Terminal Attachment

**Description:** An operator opens a Connect panel and sees the live terminal output of a running worker session, streamed in real time.

**Feature flag:** `CONNECT_FEATURE_LIVE_TERMINAL`

#### Boundary Table

| Concern | Polaris Responsibility | Connect Responsibility |
|---|---|---|
| Session identity | Store `session_id`, `worker_id`, `dispatch_id`, `provider` on `ChildDispatchRecord` at dispatch time | Use `session_id` + `provider` to route the attachment request to the correct provider adapter |
| Attachment capability | Set `attachment_capable: true` on `ChildDispatchRecord` when provider supports session attachment | Check `attachment_capable` before attempting attachment; surface graceful degradation message when `false` |
| Provider session access | Populate `session_id` from the provider after session establishment | Open a streaming connection to the provider using `session_id` |
| Terminal stream | Emit structured heartbeat events with `step` field for fallback polling | Stream raw terminal output to operator browser; render in UI |
| Session recency | Store `dispatched_at` | Validate session recency before displaying stream; warn operator if session is stale |
| State visibility | Keep `runtime_state` current in `ChildDispatchRecord` | Display runtime state label alongside terminal stream |

#### What Polaris must store today

| Field | Location | Reason |
|---|---|---|
| `session_id` | `ChildDispatchRecord` | Connect uses this as the provider session token to open the terminal stream |
| `worker_id` | `ChildDispatchRecord` | Correlates the Connect session to the dispatch record for audit purposes |
| `attachment_capable` | `ChildDispatchRecord` | Gate: Connect only attempts attachment when `true` |
| `provider` | `ChildDispatchRecord` | Determines which Connect terminal adapter to invoke |
| `dispatch_id` | `ChildDispatchRecord` | End-to-end correlation key for all events in the session |
| `dispatched_at` | `ChildDispatchRecord` | Session recency validation |
| `run_id` | `ChildDispatchRecord` | Associates the terminal stream with the active run |
| `cluster_id` | `ChildDispatchRecord` | Associates the terminal stream with the cluster |

#### Migration cost if not stored today

If `session_id` and `attachment_capable` are absent when Connect is enabled:
- Every in-flight dispatch record must be backfilled with a null `session_id` and `attachment_capable: false`.
- Historical dispatch records in completed runs cannot be backfilled (no provider session available after completion).
- Connect cannot attach to any session from before the migration date.
- The Foreman must be updated to write these fields before Connect can operate, requiring a coordinated deploy.

---

### 1.2 Session Viewing

**Description:** An operator views the full context of a worker session: its assigned child, current step, heartbeat history, progress estimate, and final result.

**Feature flag:** `CONNECT_FEATURE_SESSION_VIEWING`

#### Boundary Table

| Concern | Polaris Responsibility | Connect Responsibility |
|---|---|---|
| Child context | Store `child_id`, `run_id`, `cluster_id`, `packet_path` on `ChildDispatchRecord` | Fetch and render the packet file contents for operator review |
| Heartbeat history | Store `last_heartbeat_at`, `last_heartbeat_step`, `first_heartbeat_at`, `heartbeat_count` on `ChildDispatchRecord` | Display heartbeat timeline, time-to-first-heartbeat, and progress |
| Progress estimate | Store `progress_pct` on heartbeat events in telemetry log | Render progress bar or percentage in session view |
| State history | Emit `loop-checkpoint` events to telemetry log | Reconstruct state timeline from telemetry; display in UI |
| Current state | Keep `runtime_state` current on `ChildDispatchRecord` | Display current lifecycle state label |
| Result summary | Store `ChildResultSummary` in `completed_children_results` on `LoopState` | Display result status, validation outcome, and recommended action |
| Result artifact | Write CompactReturn to `expected_result_path` | Fetch and display result artifact when available |

#### What Polaris must store today

| Field | Location | Reason |
|---|---|---|
| `first_heartbeat_at` | `ChildDispatchRecord` | Connect displays time-to-first-heartbeat as a session quality metric |
| `heartbeat_count` | `ChildDispatchRecord` | Connect displays heartbeat frequency; enables gap detection |
| `last_heartbeat_at` | `ChildDispatchRecord` | Connect shows last-known-alive timestamp |
| `last_heartbeat_step` | `ChildDispatchRecord` | Connect shows last-known activity description |
| `runtime_state` | `ChildDispatchRecord` | Connect displays lifecycle state |
| `completed_children_results` | `LoopState` | Connect reads result summary after completion |
| Telemetry log (NDJSON) | Run artifact dir | Connect reconstructs event timeline for session view |

#### Migration cost if not stored today

If `first_heartbeat_at` and `heartbeat_count` are absent:
- Session quality metrics (time-to-first-heartbeat, heartbeat gap analysis) cannot be computed for past sessions.
- Connect can only display current snapshot; historical heartbeat timeline is unavailable.
- No schema migration is required, but metric computation must be forward-only from the migration date.

---

### 1.3 Worker Interruption

**Description:** An operator sends an interrupt signal to a running worker, causing it to stop at the next safe checkpoint.

**Feature flag:** `CONNECT_FEATURE_WORKER_INTERRUPTION`

#### Boundary Table

| Concern | Polaris Responsibility | Connect Responsibility |
|---|---|---|
| Session addressability | Store `session_id` and `provider` on `ChildDispatchRecord` | Use `session_id` + `provider` to route the interrupt signal to the correct provider |
| Interrupt signal delivery | Define and document the interrupt protocol per provider in the provider capability registry | Send the interrupt signal via the provider adapter; handle delivery confirmation |
| State update after interrupt | Transition `runtime_state` to `"blocked"` or `"failed"` upon receiving interrupt acknowledgment; write `BlockerRecord` with reason `"operator-interrupt"` | Display interrupt confirmation to operator; show updated state in session view |
| Interrupt audit event | Emit `operator-interrupt` event to telemetry log with `dispatch_id`, `worker_id`, `operator_id`, timestamp | Log operator identity; authenticate operator before sending interrupt |
| Interrupt capability | Expose `attachment_capable` as proxy for interrupt capability (interrupt requires the same session attachment prerequisite) | Only offer interrupt UI when `attachment_capable: true` and `runtime_state` is an interruptible state |
| CompactReturn on interrupt | Worker must write a partial CompactReturn before exiting when interrupted | Detect interrupt-triggered CompactReturn by checking result status field |

#### What Polaris must store today

| Field | Location | Reason |
|---|---|---|
| `session_id` | `ChildDispatchRecord` | Connect routes interrupt signal to provider using `session_id` |
| `attachment_capable` | `ChildDispatchRecord` | Gate: interrupt is only possible for attachment-capable sessions |
| `runtime_state` | `ChildDispatchRecord` | Defines which states permit operator interruption |
| `blocker` | `LoopState` | Stores interrupt record for orchestrator resume decision |
| Telemetry log | Run artifact dir | Interrupt events must be appended for audit trail |

#### Migration cost if not stored today

If `session_id` and `attachment_capable` are absent:
- Worker interruption is impossible for all sessions dispatched before the migration.
- The interrupt routing logic in Connect cannot be backfilled.
- All in-flight sessions at migration time would be non-interruptible until completion.

---

### 1.4 Worker Takeover

**Description:** An operator terminates the current worker session and assumes control of the child task — either to handle it manually, re-dispatch it to a different provider, or perform diagnostic actions.

**Feature flag:** `CONNECT_FEATURE_WORKER_TAKEOVER`

#### Boundary Table

| Concern | Polaris Responsibility | Connect Responsibility |
|---|---|---|
| Session termination | Transition `runtime_state` to `"orphaned"` after operator confirms takeover; archive current dispatch record as `previous_dispatch_record` | Present takeover confirmation dialog; confirm operator intent before triggering termination |
| Provider session teardown | Provider adapter must implement `teardown(session_id)` per provider capability contract | Call Polaris teardown API; handle teardown confirmation or timeout |
| Takeover state | Set `runtime_state: "blocked"` with `blocker.reason: "operator-takeover"` after teardown; persist `BlockerRecord` | Display takeover state in session view; prompt operator for next action |
| Re-dispatch eligibility | After takeover, the child MUST be re-dispatchable via normal Foreman dispatch (new `dispatch_id`, new `worker_id`) | If operator selects "re-dispatch to different provider," present provider selection UI and submit dispatch request |
| Manual completion | Accept a manual CompactReturn submitted by the operator through Connect | Provide form UI for operator to supply result summary and commit reference |
| Takeover audit | Emit `operator-takeover` event to telemetry log with `dispatch_id`, `worker_id`, `operator_id`, prior `session_id`, timestamp | Authenticate operator; record operator identity in event payload |
| Prior session archive | Retain prior `dispatch_id`, `session_id`, `worker_id` in `previous_dispatch_record` nested on the new dispatch record | Display takeover provenance in session history |

#### What Polaris must store today

| Field | Location | Reason |
|---|---|---|
| `session_id` | `ChildDispatchRecord` | Required for provider session teardown routing |
| `worker_id` | `ChildDispatchRecord` | Correlates takeover event to prior dispatch for audit trail |
| `dispatch_id` | `ChildDispatchRecord` | Persisted in `previous_dispatch_record` after re-dispatch |
| `attachment_capable` | `ChildDispatchRecord` | Gate: takeover requires session addressability |
| `runtime_state` | `ChildDispatchRecord` | Defines which states permit takeover; used for re-dispatch eligibility check |
| `blocker` | `LoopState` | Orchestrator reads blocker record to determine re-dispatch or escalation path |
| Telemetry log | Run artifact dir | Takeover events must be appended for audit and replay |

#### Migration cost if not stored today

If `session_id` and `worker_id` are absent:
- Takeover audit trail is incomplete: the `previous_dispatch_record` cannot link the takeover event back to the original session.
- Provider teardown routing is impossible for sessions without `session_id`.
- Historical runs taken over before migration cannot be replayed or audited by Connect.

---

### 1.5 Multi-Worker Visibility

**Description:** An operator views all active workers across a run — their states, progress, and session health — in a single dashboard panel.

**Feature flag:** `CONNECT_FEATURE_MULTI_WORKER_VISIBILITY`

#### Boundary Table

| Concern | Polaris Responsibility | Connect Responsibility |
|---|---|---|
| Worker enumeration | Maintain `open_children_meta` on `LoopState` with a `dispatch_record` per active child | Query `LoopState` and render a row per active child in the dashboard |
| Per-worker state | Keep `runtime_state` current per `ChildDispatchRecord` | Display per-worker lifecycle state with color coding |
| Per-worker progress | Store `last_heartbeat_step`, `last_heartbeat_at`, `heartbeat_count` per `ChildDispatchRecord` | Display last-known step and heartbeat recency indicator per worker |
| Completed worker history | Maintain `completed_children_results` on `LoopState` with `ChildResultSummary` per completed child | Render completed worker rows with result status and validation outcome |
| Cluster context | Store `cluster_id` and `run_id` on `LoopState` | Scope the multi-worker view to a specific run/cluster |
| Run-level status | Store `status` on `LoopState` | Display overall run status in dashboard header |
| Parallel dispatch evidence | Store `dispatch_boundary` (`dispatch_epoch`, `continue_epoch`) on `LoopState` | Not Connect's concern — internal Polaris invariant |
| Worker count metrics | Derive from `open_children` array length and `completed_children` array length | Display active/completed worker counts in dashboard |

#### What Polaris must store today

| Field | Location | Reason |
|---|---|---|
| `open_children_meta` | `LoopState` | Connect enumerates active workers from this map |
| `dispatch_record` (per child) | `open_children_meta[child_id]` | Connect reads per-worker session fields from dispatch records |
| `runtime_state` (per child) | `ChildDispatchRecord` | Connect displays per-worker lifecycle state |
| `last_heartbeat_at` (per child) | `ChildDispatchRecord` | Connect computes heartbeat recency per worker |
| `last_heartbeat_step` (per child) | `ChildDispatchRecord` | Connect displays last activity per worker |
| `completed_children_results` | `LoopState` | Connect renders completed worker results |
| `cluster_id`, `run_id` | `LoopState` | Connect scopes the dashboard view |

#### Migration cost if not stored today

If `open_children_meta` dispatch records are incomplete (missing `runtime_state`, `last_heartbeat_at`):
- Multi-worker dashboard displays stale or unknown state for workers active before migration.
- No per-worker progress data is available for historical sessions.
- Connect must fall back to polling `LoopState` status field only, which provides no per-worker granularity.

---

## 2. Session Fields Polaris Must Store Today

The following table consolidates all fields required across all five Connect features. These fields MUST be stored by Polaris today to prevent migration cost at Connect enablement time.

### 2.1 `ChildDispatchRecord` Fields

| Field | Type | Required for Feature(s) | Status in `checkpoint.ts` |
|---|---|---|---|
| `session_id` | `string \| null` | Live Terminal, Worker Interruption, Worker Takeover | **[gap]** — absent |
| `worker_id` | `string` | Live Terminal, Worker Takeover, Session Viewing | **[gap]** — absent |
| `attachment_capable` | `boolean` | Live Terminal, Worker Interruption, Worker Takeover | **[gap]** — absent |
| `provider` | `string \| undefined` | Live Terminal | Present (optional) |
| `dispatch_id` | `string` | All features (correlation key) | Present |
| `dispatched_at` | `string` | Live Terminal (recency) | Present |
| `run_id` | `string` | All features | Present |
| `cluster_id` | `string` | All features | Present |
| `child_id` | `string` | Session Viewing, Multi-Worker | Present |
| `runtime_state` | `WorkerRuntimeState` | Session Viewing, Worker Interruption, Worker Takeover, Multi-Worker | Present (optional) |
| `last_heartbeat_at` | `string \| undefined` | Session Viewing, Multi-Worker | Present (optional) |
| `last_heartbeat_step` | `string \| undefined` | Session Viewing, Multi-Worker | Present (optional) |
| `first_heartbeat_at` | `string \| undefined` | Session Viewing | **[gap]** — absent |
| `heartbeat_count` | `number \| undefined` | Session Viewing, Multi-Worker | **[gap]** — absent |

### 2.2 `LoopState` Fields

| Field | Type | Required for Feature(s) | Status in `checkpoint.ts` |
|---|---|---|---|
| `open_children_meta` | `Record<string, {..., dispatch_record?}>` | Multi-Worker, all per-worker queries | Present (optional) |
| `completed_children_results` | `Record<string, ChildResultSummary>` | Session Viewing, Multi-Worker | Present (optional) |
| `cluster_id` | `string` | Multi-Worker | Present |
| `run_id` | `string` | Multi-Worker | Present |
| `status` | `string` | Multi-Worker | Present |
| `branch` | `string \| undefined` | Session Viewing (context) | Present (optional) |

### 2.3 Telemetry Log Events

The following event types must be emitted to the run telemetry log to support Connect queries:

| Event type | Emitted by | Required for feature(s) |
|---|---|---|
| `loop-checkpoint` | Foreman (on state transition) | Session Viewing (state timeline) |
| `loop-aborted` | Foreman (on abort) | Session Viewing, Worker Interruption |
| `analyze-impl-boundary-enforced` | Foreman | Session Viewing |
| `operator-interrupt` *(future)* | Connect via Polaris API | Worker Interruption (audit) |
| `operator-takeover` *(future)* | Connect via Polaris API | Worker Takeover (audit) |

Events marked *(future)* are emitted by Connect but written to the Polaris telemetry log via a Polaris API endpoint. Polaris must define the `appendAuditEvent` function to accept these events when `CONNECT_FEATURE_WORKER_INTERRUPTION` or `CONNECT_FEATURE_WORKER_TAKEOVER` is enabled.

---

## 3. Feature Flag Strategy

### 3.1 Flag Definitions

Each Connect feature is gated by an independent boolean feature flag. Flags are evaluated at runtime by the Foreman and by Connect independently.

| Flag | Default | Controls |
|---|---|---|
| `CONNECT_FEATURE_LIVE_TERMINAL` | `false` | Enables live terminal attachment; requires `attachment_capable: true` and non-null `session_id` |
| `CONNECT_FEATURE_SESSION_VIEWING` | `false` | Enables session context, heartbeat history, and result viewing in Connect UI |
| `CONNECT_FEATURE_WORKER_INTERRUPTION` | `false` | Enables operator-initiated interrupt signal delivery; requires `attachment_capable: true` |
| `CONNECT_FEATURE_WORKER_TAKEOVER` | `false` | Enables operator-initiated session termination and re-dispatch; requires `attachment_capable: true` |
| `CONNECT_FEATURE_MULTI_WORKER_VISIBILITY` | `false` | Enables multi-worker dashboard panel in Connect UI |

### 3.2 Flag Evaluation Rules

**Polaris-side evaluation:**
- Polaris evaluates flags to decide whether to emit additional events to the telemetry log (e.g., richer heartbeat payloads when `CONNECT_FEATURE_SESSION_VIEWING` is enabled).
- Polaris evaluates `CONNECT_FEATURE_WORKER_INTERRUPTION` to decide whether to register the interrupt signal handler on dispatch records.
- Flag values are read from environment variables or a feature flag config file at Foreman startup.

**Connect-side evaluation:**
- Connect evaluates flags to decide which UI panels, controls, and API calls to enable.
- Connect respects Polaris-set `attachment_capable` as a hard gate regardless of flag state.

**Dependency ordering:**
- `CONNECT_FEATURE_LIVE_TERMINAL` depends on `session_id` and `attachment_capable` being populated. If these fields are absent (legacy records), the flag has no effect for those records.
- `CONNECT_FEATURE_WORKER_INTERRUPTION` and `CONNECT_FEATURE_WORKER_TAKEOVER` both depend on `CONNECT_FEATURE_LIVE_TERMINAL`-level session addressability.
- `CONNECT_FEATURE_MULTI_WORKER_VISIBILITY` depends on `CONNECT_FEATURE_SESSION_VIEWING` data being available per worker.

**Recommended enablement order:** `SESSION_VIEWING` → `LIVE_TERMINAL` → `MULTI_WORKER_VISIBILITY` → `WORKER_INTERRUPTION` → `WORKER_TAKEOVER`

### 3.3 Backward Compatibility

- Existing dispatch records without `session_id`, `worker_id`, or `attachment_capable` are treated as non-attachment-capable by Connect.
- Connect must not throw on missing optional fields; it must degrade gracefully.
- All five feature flags are additive: enabling any flag does not change Polaris dispatch behavior or storage schema.

---

## 4. Attachment Capability Detection Per Provider

The following table defines `attachment_capable` for each known Polaris provider. This is a static provider capability, not a runtime state.

| Provider | `attachment_capable` | Reason |
|---|---|---|
| `subagent` | `true` | Subagent sessions have stable `session_id` (equivalent to `subagent_session_id`); Connect can address them directly |
| `copilot` | `true` | Copilot agent sessions provide a session token; attachment protocol is supported |
| `windsurf` | `true` | Cascade sessions support persistent attachment |
| `gemini` | `false` | CLI invocation; no persistent session token emitted; stdout-only |
| `codex` | `false` | CLI invocation; no persistent session; fire-and-forget |
| `external-process` | `false` | Only a process PID is available; no session protocol |
| `human-handoff` | `false` | Human actor; no automated attachment |
| `pending-escalation` | `false` | Session not yet established |

**Detection mechanism:** The provider adapter declares `supports_attachment: true | false` in the provider capability registry. The adapter sets `attachment_capable` on `ChildDispatchRecord` at dispatch time, after provider session establishment. Polaris does not infer attachment capability from `provider` name at runtime — it reads `attachment_capable` from the dispatch record.

---

## 5. Connect Responsibilities (Out of Polaris Scope)

The following concerns are entirely owned by Connect. Polaris does not implement these.

### 5.1 UI Rendering and Streaming
- Terminal stream rendering, syntax highlighting, scroll behavior.
- Session view layout, heartbeat timeline visualization, progress bar rendering.
- Multi-worker dashboard panel layout and refresh behavior.

### 5.2 Streaming and Session Proxying
- Establishing and maintaining the streaming connection to the provider using `session_id`.
- Handling provider-specific stream formats (PTY streams, JSON event streams, SSE).
- Proxy authentication to the provider session on the operator's behalf.
- Reconnection and backpressure handling for terminal streams.

### 5.3 Operator Authentication and Authorization
- Authenticating operators before granting access to session views, interrupt, or takeover controls.
- Role-based access control: distinguishing read-only observers from operators with interrupt/takeover permissions.
- Audit logging of operator identity in `operator-interrupt` and `operator-takeover` events.
- Session token management for the Connect operator session (distinct from the worker `session_id`).

### 5.4 Session Takeover Protocol
- Confirming operator intent via UI before executing interrupt or takeover.
- Submitting the teardown request to Polaris API.
- Providing the manual CompactReturn submission form for operator-completed children.
- Managing the operator's "workspace" after takeover (what the operator sees and can act on).

---

## 6. Gap Analysis vs Current `checkpoint.ts`

This section documents Connect-relevant fields that are currently absent from `ChildDispatchRecord` and `LoopState` in `src/loop/checkpoint.ts`. This is a findings-only analysis — no source changes are made here.

### 6.1 `ChildDispatchRecord` Gaps

**Gap 1: `session_id: string | null` — ABSENT**

`session_id` is the provider-assigned session identifier that Connect uses as the primary routing key for live terminal attachment, interrupt delivery, and session teardown. Without this field, all three Connect features that require session addressability (`LIVE_TERMINAL`, `WORKER_INTERRUPTION`, `WORKER_TAKEOVER`) cannot function for any dispatch record written before the field is added.

The current schema stores `worker_assignment.subagent_session_id` as a nested field under `WorkerAssignmentRecord`, but this field is:
- Only populated for `assignment_type: "subagent"` — absent for all other providers.
- Nested three levels deep, requiring Connect to know the dispatch mode and assignment type before locating the session ID.
- Not the canonical session identity field defined in the worker session contract (POL-214).

`session_id` must be added as a top-level field on `ChildDispatchRecord`, defaulting to `null` at packet creation, set by the provider adapter after session establishment.

**Gap 2: `worker_id: string` — ABSENT**

`worker_id` is the stable entity identifier for the worker executing a dispatch. The current schema uses `dispatch_id` as the only unique key, but `dispatch_id` is event-scoped (one per dispatch invocation) and changes on re-dispatch. `worker_id` must be the entity key that Connect uses to correlate audit events (operator-interrupt, operator-takeover) across re-dispatch cycles.

Without `worker_id`, Connect's takeover audit trail cannot link the takeover event to the original session identity in a provider-agnostic way.

**Gap 3: `attachment_capable: boolean` — ABSENT**

`attachment_capable` is the hard gate that Connect evaluates before attempting any session-addressed operation. Without this field, Connect must infer attachment capability from `provider` at query time — a fragile approach that breaks when new providers are added or when a provider's capability changes.

The field must be stored as a boolean (not derived) on `ChildDispatchRecord` so that Connect can read it with a single field lookup, without provider-specific logic.

**Gap 4: `first_heartbeat_at: string | undefined` — ABSENT**

`first_heartbeat_at` is required for Connect's Session Viewing feature to display time-to-first-heartbeat, a key dispatch quality metric. Without it, Connect can only display "last heartbeat" with no baseline for comparison.

**Gap 5: `heartbeat_count: number | undefined` — ABSENT**

`heartbeat_count` enables Connect to detect heartbeat gaps: a high count with a recent `last_heartbeat_at` indicates healthy execution; a low count with an old `last_heartbeat_at` indicates a possible stall. Without this field, Connect can only display the last heartbeat timestamp with no frequency context.

### 6.2 `LoopState` Gaps

No structural gaps are identified in `LoopState` at the top level for Connect purposes. The existing fields (`open_children_meta`, `completed_children_results`, `cluster_id`, `run_id`, `status`, `branch`) are sufficient for multi-worker visibility and session viewing at the run level.

The per-worker gaps are rooted in `ChildDispatchRecord` (via `open_children_meta[child_id].dispatch_record`) — specifically the five fields identified in §6.1. Fixing those fields in `ChildDispatchRecord` is sufficient to close the `LoopState`-level Connect gaps as well.

**Minor observation: `open_children_meta` is optional in `LoopState`.**  
For Connect to enumerate active workers reliably, `open_children_meta` must be populated for every active child. The current schema types it as `Record<...> | undefined`, which means a `LoopState` without this field is valid. Connect must handle absence gracefully and fall back to listing `open_children` IDs without dispatch record detail.

**Minor observation: `completed_children_results` is optional in `LoopState`.**  
Same concern as above. Connect must handle absence gracefully for completed worker rows.

### 6.3 Missing Event Types

The following event types are not currently defined in `checkpoint.ts` but are required to support the Connect audit trail:

| Event type | Required for | Current status |
|---|---|---|
| `operator-interrupt` | `CONNECT_FEATURE_WORKER_INTERRUPTION` audit log | Not defined |
| `operator-takeover` | `CONNECT_FEATURE_WORKER_TAKEOVER` audit log | Not defined |

These events will be emitted by Connect and appended to the Polaris telemetry log via an API call. Polaris must define the append function and event schema before `WORKER_INTERRUPTION` or `WORKER_TAKEOVER` can be enabled. This is a future concern — no action required today.

---

## 7. Summary: What Polaris Stores Today vs What Connect Does Later

| Connect Feature | Flag | Polaris stores today | Connect does when enabled |
|---|---|---|---|
| Live Terminal Attachment | `CONNECT_FEATURE_LIVE_TERMINAL` | `session_id`, `worker_id`, `attachment_capable`, `provider`, `dispatch_id`, `dispatched_at` | Opens terminal stream to provider via `session_id`; renders in UI |
| Session Viewing | `CONNECT_FEATURE_SESSION_VIEWING` | `first_heartbeat_at`, `heartbeat_count`, `last_heartbeat_at`, `last_heartbeat_step`, `runtime_state`, `completed_children_results` | Fetches and renders session context, heartbeat timeline, result summary |
| Worker Interruption | `CONNECT_FEATURE_WORKER_INTERRUPTION` | `session_id`, `attachment_capable`, `runtime_state`, `blocker` | Authenticates operator; routes interrupt signal via `session_id`; writes audit event |
| Worker Takeover | `CONNECT_FEATURE_WORKER_TAKEOVER` | `session_id`, `worker_id`, `dispatch_id`, `attachment_capable`, `runtime_state`, `blocker` | Confirms operator intent; calls teardown; archives prior dispatch record; accepts manual result |
| Multi-Worker Visibility | `CONNECT_FEATURE_MULTI_WORKER_VISIBILITY` | `open_children_meta` with populated dispatch records, `completed_children_results`, `cluster_id`, `run_id` | Renders per-worker dashboard; polls `LoopState` for updates |

---

## 8. Invariants

| Invariant | Description |
|---|---|
| `attachment_capable` is a stored field | Connect reads `attachment_capable` from the dispatch record; it never infers it from `provider` at query time |
| Feature flags are additive | Enabling any Connect feature flag does not change Polaris dispatch behavior or schema |
| Session fields are set at dispatch time | `session_id`, `worker_id`, `attachment_capable` are set by the Foreman/adapter before any Connect feature can read them |
| Connect does not write to `LoopState` | Connect reads Polaris state; it does not modify `LoopState` directly. State mutations (interrupt, takeover) go through Polaris API |
| Graceful degradation is required | Connect must not fail if optional fields (`session_id`, `attachment_capable`, `open_children_meta`) are absent; it must degrade to a reduced feature set |
| No session field reuse across re-dispatches | A `session_id` from a prior dispatch is never reused; `previous_dispatch_record` retains the prior values for audit purposes |
