# Foreman-to-Worker Architecture Spec

**Status:** Authoritative architecture spec  
**Issue:** POL-212  
**Cluster:** POL-211  
**Created:** 2026-05-29

---

## Overview

This document defines the canonical Foreman-to-Worker architecture for the Polaris runtime. It governs how the Foreman dispatches workers, how workers receive and execute assignments, how delegated dispatch flows through the subagent escalation path, and how direct provider dispatch is architectured for external providers.

This spec is authoritative. Any implementation that diverges from this document requires a superseding spec approved by the cluster authority.

---

## 1. Foreman Doctrine

### 1.1 Foreman Responsibilities

The Foreman is the sole orchestration authority for a run. Its responsibilities are:

| Responsibility | Description |
|---|---|
| **Dispatch** | Select the next child from the open queue, construct the assignment packet, and dispatch it to a worker via the appropriate mode. |
| **Checkpoint** | Write durable checkpoint state before and after each dispatch event. No dispatch occurs without a prior checkpoint write. |
| **Budget enforcement** | Track `context_budget.children_completed` against `max_children_per_session`. When the budget is exhausted, stop dispatching and emit a budget-exhaustion escalation. |
| **Escalation** | When a worker fails, a blocker is raised, or a dispatch cannot be completed, the Foreman escalates to the appropriate handler rather than retrying silently. |
| **Lifecycle ownership** | The Foreman owns the full lifecycle of every child: from `open_children` to `completed_children`. No child transitions state without Foreman authority. |
| **Seal verification** | Before any dispatch, the Foreman verifies the `run_bootstrap_seal` is intact. A missing or invalid seal is a hard stop. |

### 1.2 Foreman Restrictions

The Foreman MUST NOT:

- **Execute source code** or perform any implementation work inline. The Foreman's only execution is orchestration logic (state reads, checkpoint writes, packet construction, worker dispatch).
- **Reason about source code** beyond what is required to construct an accurate assignment packet (e.g., reading a referenced file path to validate it exists is permitted; analyzing logic is not).
- **Expand child scope** beyond what is defined in the cluster plan.
- **Modify worker packets** after emission. Once a packet is written, it is immutable.
- **Skip checkpoint writes.** Every state transition must be durably checkpointed before it is acted upon.
- **Dispatch more than one child per continue epoch.** The dispatch boundary invariant (`dispatch_epoch > continue_epoch`) enforces this. Violating it is a hard fault.

### 1.3 Assignment Requirements

A valid assignment packet MUST contain:

| Field | Required | Description |
|---|---|---|
| `dispatch_id` | Yes | Unique identifier for this dispatch event (UUID or equivalent). |
| `child_id` | Yes | The child issue ID being dispatched. |
| `run_id` | Yes | The active run ID. |
| `cluster_id` | Yes | The cluster this child belongs to. |
| `packet_path` | Yes | Absolute path to the packet file on disk. |
| `expected_result_path` | Yes | Path where the worker MUST write its `CompactReturn`. |
| `dispatch_mode` | Yes | `"delegated"` or `"direct-worker"`. |
| `dispatched_at` | Yes | ISO 8601 timestamp of dispatch. |
| `runtime_state` | Yes | Initial state: `"packet-created"`. |
| `provider` | Conditional | Required if `dispatch_mode` is `"direct-worker"`. |

A packet that is missing any required field MUST NOT be dispatched. The Foreman MUST log the validation failure and escalate if retries are exhausted.

### 1.4 Escalation Requirements

The Foreman MUST escalate when:

- A worker does not emit a heartbeat within the defined heartbeat timeout window.
- A worker emits a `CompactReturn` with `exit_code !== 0`.
- A worker reports a blocker condition it cannot self-resolve.
- The dispatch mechanism fails (subagent spawn failure, process launch failure, provider API error).
- The `run_bootstrap_seal` fails verification.
- The context budget is exhausted.

Escalation procedure:
1. Write a `BlockerRecord` to the checkpoint with `resolved: false`.
2. Set `runtime_state` to `"blocked"` or `"failed"` as appropriate.
3. Emit a structured escalation event to the audit log.
4. Stop dispatching. Do not proceed to the next child until the blocker is resolved or a human-handoff escalation has been emitted.

### 1.5 Worker Selection Behavior

The Foreman selects workers according to dispatch mode:

**Delegated mode** (`dispatch_mode: "delegated"`):
- Used when no provider is explicitly specified in the child definition.
- The Foreman attempts subagent spawning first.
- If subagent spawning is unavailable, falls back to external-process.
- If external-process is unavailable, escalates to human-handoff.
- If human-handoff cannot be arranged, emits `pending-escalation` and stops.

**Direct-worker mode** (`dispatch_mode: "direct-worker"`):
- Used when a provider is explicitly specified in the child definition (e.g., `provider: "copilot"`).
- The Foreman dispatches directly to the named provider's integration.
- No subagent fallback is attempted.
- If the provider integration is unavailable, escalates immediately.

### 1.6 Canonical Dispatch Decision Matrix

| Condition | Dispatch Mode | Worker Selection |
|---|---|---|
| Provider explicitly requested | `direct-worker` | Named provider integration (see §4) |
| No provider specified; subagents supported | `delegated` | Subagent spawning (see §3.2) |
| No provider specified; subagents not supported; external-process available | `delegated` | External-process launch |
| No provider specified; no subagents; no external-process | `delegated` | Human-handoff or `pending-escalation` |

---

## 2. Worker Doctrine

### 2.1 Worker Ownership Rules

- **One worker per child.** A child MUST NOT be executed by more than one worker concurrently.
- **Foreman owns the lifecycle.** The worker does not self-assign, self-promote, or self-terminate outside the packet contract. The Foreman transitions the child's runtime state based on worker emissions (heartbeats, CompactReturn).
- **Workers do not modify the cluster plan.** A worker MUST NOT add, remove, or reorder children in the open queue.
- **Worker scope is bounded by the packet.** The worker MUST NOT perform work outside the `allowed_changes` and `scope` fields defined in its assignment packet.

### 2.2 Packet Authority

- The worker MUST read the packet at `packet_path` before beginning work.
- The worker MUST emit an acknowledgment (see §2.4) immediately upon successful packet read.
- The worker MUST NOT modify the packet file. The packet is immutable after emission by the Foreman.
- If the worker detects a packet integrity violation (missing required fields, seal mismatch), it MUST emit a failure CompactReturn with `exit_code: 1` and a descriptive `error` field. It MUST NOT proceed with execution.

### 2.3 Heartbeat Requirements

Workers operating in long-running tasks MUST emit heartbeats to the checkpoint system.

| Field | Required | Description |
|---|---|---|
| `child_id` | Yes | The child being executed. |
| `run_id` | Yes | The active run ID. |
| `timestamp` | Yes | ISO 8601 timestamp of the heartbeat. |
| `step` | Yes | Human-readable description of current step. |
| `runtime_state` | Yes | Current runtime state (e.g., `"running"`). |
| `progress_pct` | No | Optional 0–100 progress estimate. |

**Heartbeat frequency:** At minimum once every 60 seconds during active execution. A worker that exceeds 120 seconds without a heartbeat is considered stale and the Foreman MAY escalate it to `"orphaned"`.

### 2.4 Acknowledgment Requirements

Upon reading the packet, the worker MUST emit an acknowledgment record to the checkpoint. The acknowledgment MUST contain:

| Field | Required | Description |
|---|---|---|
| `dispatch_id` | Yes | The dispatch ID from the packet. |
| `child_id` | Yes | The child ID. |
| `acknowledged_at` | Yes | ISO 8601 timestamp. |
| `worker_identity` | Yes | Identifier for the worker session (session ID, process ID, or provider-assigned ID). |

A worker that cannot write the acknowledgment MUST abort and emit a failure CompactReturn. The Foreman treats an unacknowledged packet as a dispatch failure after the heartbeat timeout window.

### 2.5 Completion Requirements

When a worker finishes execution (success or failure), it MUST write a `CompactReturn` to `expected_result_path`.

**CompactReturn fields:**

| Field | Required | Description |
|---|---|---|
| `child_id` | Yes | The child ID. |
| `run_id` | Yes | The active run ID. |
| `dispatch_id` | Yes | The dispatch ID from the packet. |
| `exit_code` | Yes | `0` = success; non-zero = failure. |
| `status` | Yes | `"success"` or `"failure"`. |
| `completed_at` | Yes | ISO 8601 completion timestamp. |
| `summary` | Yes | Human-readable summary of what was done. |
| `artifacts` | No | List of created/modified artifact paths. |
| `error` | Conditional | Required if `exit_code !== 0`. Human-readable error description. |
| `blocker` | Conditional | Required if worker could not complete due to a blocker. Must include `reason` and `unblock_condition`. |

**Exit code contract:**
- `0`: Worker completed all assigned work successfully. Foreman may advance the queue.
- `1`: Worker encountered a fatal error. Foreman MUST NOT advance the queue until the error is resolved.
- `2`: Worker is blocked and requires Foreman intervention. Foreman escalates.
- `3`: Worker exceeded scope and self-terminated. Foreman logs and escalates.

---

## 3. Delegated Dispatch

### 3.1 Internal Worker Fallback Definition

In delegated mode, "internal worker" refers to a worker executed within the same runtime context as the Foreman — specifically, a subagent spawned by the Foreman's session. This is the preferred execution mechanism when the runtime supports subagent spawning.

An internal worker:
- Shares the parent session's tool permissions (subject to session policy).
- Has access to the same working directory.
- Is ephemeral: its session ends when the CompactReturn is written.
- Is isolated from the Foreman's execution state: it reads the packet, does its work, and writes the result.

### 3.2 Subagent Spawning Expectations

When subagent spawning is the selected mechanism:

1. The Foreman constructs the assignment packet and writes it to `packet_path`.
2. The Foreman writes a dispatch record with `assignment_type: "subagent"`.
3. The Foreman spawns a subagent session, passing the packet path and run context.
4. The subagent reads the packet, emits acknowledgment, executes, and writes the CompactReturn.
5. The Foreman monitors for heartbeat and CompactReturn. On timeout, escalates to the next fallback.
6. On successful CompactReturn with `exit_code: 0`, the Foreman advances the queue.

The subagent's `subagent_session_id` MUST be recorded in the `WorkerAssignmentRecord` for audit trail continuity.

### 3.3 Assignment Evidence Requirements

Every dispatch MUST produce durable assignment evidence before the worker begins execution. Evidence is stored as a `ChildDispatchRecord` in the checkpoint system.

Required evidence for delegated dispatch:

| Evidence Field | Description |
|---|---|
| `dispatch_id` | Unique ID for this dispatch event. |
| `dispatched_at` | When the dispatch was initiated. |
| `dispatch_mode` | `"delegated"`. |
| `runtime_state` | Lifecycle state at time of evidence write. |
| `worker_assignment.assigned_at` | When the assignment was made. |
| `worker_assignment.assignment_type` | Which mechanism was used. |
| `worker_assignment.subagent_session_id` | For subagent assignments. |
| `worker_assignment.process_pid` | For external-process assignments. |
| `worker_assignment.handoff_token` | For human-handoff assignments. |
| `worker_assignment.escalation_reason` | For pending-escalation assignments. |

Evidence MUST be written before the worker begins execution. A dispatch without evidence is a protocol violation.

### 3.4 Escalation Paths

Delegated dispatch escalation follows a strict ordered fallback:

```
subagent
  └── (unavailable or failed) → external-process
        └── (unavailable or failed) → human-handoff
              └── (unavailable or failed) → pending-escalation
                    └── (always) → STOP: Foreman halts queue advancement
```

At each level:
- **subagent**: Attempted when the Foreman session supports subagent spawning. Failure includes spawn error, timeout without acknowledgment, or CompactReturn with non-zero exit.
- **external-process**: Attempted when an external Polaris worker process can be launched. Tracked by `process_pid`. Failure includes launch error, timeout, or non-zero exit.
- **human-handoff**: Attempted when a human operator can be notified to execute the child manually. Tracked by `handoff_token`. Foreman emits a structured handoff request and waits.
- **pending-escalation**: Terminal escalation. The Foreman records `escalation_reason`, sets `runtime_state: "blocked"`, and stops. No further dispatch occurs until the cluster authority intervenes.

### 3.5 Foreman Seal Integrity Requirements

The Foreman MUST verify the `run_bootstrap_seal` before every dispatch event. The seal MUST contain:

| Field | Verification Rule |
|---|---|
| `sealer` | MUST equal `"polaris-loop-bootstrap"`. |
| `run_id` | MUST match the active `run_id` in current state. |
| `cluster_id` | MUST match the active `cluster_id` in current state. |
| `sealed_at` | MUST be a valid ISO 8601 timestamp. MUST NOT be in the future. |

If any seal field fails verification:
1. Log a `SEAL_INTEGRITY_VIOLATION` audit event with the specific failure.
2. Set `status: "failed"` on the run.
3. Do NOT dispatch. Do NOT advance the queue.
4. Escalate to human-handoff immediately (no subagent or external-process fallback).

A seal integrity violation is not recoverable by automated retry.

---

## 4. Direct Provider Dispatch

Direct provider dispatch is used when a child's definition explicitly names a provider. The Foreman dispatches to the provider's integration rather than spawning an internal worker.

### 4.1 Supported Providers

| Provider | Integration Identity | Notes |
|---|---|---|
| `copilot` | GitHub Copilot (workspace/extension mode) | Dispatches via Copilot agent API or IDE extension protocol. |
| `gemini` | Google Gemini (CLI or API mode) | Dispatches via Gemini CLI tool invocation or Gemini API endpoint. |
| `codex` | OpenAI Codex (CLI or API mode) | Dispatches via Codex CLI or OpenAI API with code-oriented model. |
| `windsurf` | Windsurf IDE (Cascade orchestration mode) | Dispatches via Windsurf's Cascade operator surface. See `windsurf-orchestrator.md`. |

This spec defines architecture only. No provider integration is implemented here. Implementation is governed by the provider-specific adapter specs.

### 4.2 Ownership Model

In direct-worker mode:
- The **Foreman retains lifecycle ownership** of the child. The provider is a worker, not a co-orchestrator.
- The provider worker MUST read the packet and write the CompactReturn, same as any other worker.
- The provider worker MUST NOT escalate or advance the queue. Escalation returns to the Foreman.
- Assignment evidence requirements (§3.3) apply to direct-worker dispatch. The `ChildDispatchRecord.provider` field MUST be populated.

### 4.3 Assignment Visibility

For direct-worker dispatch, the assignment packet is the sole communication channel from Foreman to worker. Providers MUST NOT receive instructions through any other channel (e.g., sidebar chat, manual prompts) that are not reflected in the packet.

The packet for direct-worker dispatch MUST additionally include:
- `dispatch_mode: "direct-worker"`
- `provider: "<provider-name>"` (e.g., `"copilot"`)
- Provider-specific context fields as defined by the provider's adapter spec.

### 4.4 Fallback Behavior

Direct-worker dispatch does NOT have an automatic fallback chain. When a direct-worker dispatch fails:

1. Log the failure to the audit trail with `dispatch_mode: "direct-worker"` and `provider`.
2. Set `runtime_state: "failed"` on the dispatch record.
3. Escalate to the cluster authority. Do NOT attempt delegated dispatch automatically.

The cluster authority (human operator or parent orchestrator) decides whether to re-dispatch via a different provider, re-dispatch via delegated mode, or abandon the child.

### 4.5 Provider Architecture Details

#### 4.5.1 Copilot

- **Dispatch mechanism:** The Foreman writes the packet and invokes the Copilot agent via the GitHub Copilot extension API or the `@github/copilot-agent` CLI surface.
- **Assignment visibility:** The packet path is passed as a structured argument. Copilot reads the packet file directly.
- **Result contract:** Copilot worker writes CompactReturn to `expected_result_path` before session end.
- **Heartbeat:** Copilot sessions that support streaming output MAY emit heartbeat events. If no heartbeat support, the Foreman uses a longer timeout (240s vs 120s default).
- **Fallback:** None (see §4.4). Copilot failure escalates to cluster authority.

#### 4.5.2 Gemini

- **Dispatch mechanism:** The Foreman invokes Gemini via the `gemini` CLI tool or the Gemini API, passing the packet path as context.
- **Assignment visibility:** Packet is provided as a file path argument or inline context depending on the invocation surface.
- **Result contract:** Same as standard worker contract. Gemini worker writes CompactReturn to `expected_result_path`.
- **Heartbeat:** Gemini CLI sessions do not natively support heartbeat emission. Foreman uses a fixed timeout for Gemini dispatches.
- **Fallback:** None (see §4.4).

#### 4.5.3 Codex

- **Dispatch mechanism:** The Foreman invokes the Codex CLI (`codex` command) or OpenAI API with the packet path.
- **Assignment visibility:** Packet provided as a structured file argument. Codex reads the packet from disk.
- **Result contract:** Same as standard worker contract.
- **Heartbeat:** Not natively supported. Fixed timeout applies.
- **Fallback:** None (see §4.4).

#### 4.5.4 Windsurf

- **Dispatch mechanism:** The Foreman emits a dispatch signal to Windsurf's Cascade operator surface. Windsurf owns the IDE session that executes the worker. See `windsurf-orchestrator.md` for the operator surface spec.
- **Assignment visibility:** Packet is visible to the Windsurf session via the standard packet path convention. Windsurf Cascade is expected to read and act on the packet.
- **Result contract:** Same as standard worker contract. Windsurf worker writes CompactReturn to `expected_result_path`.
- **Heartbeat:** Windsurf Cascade sessions support structured event emission. Heartbeat events are expected per the standard heartbeat spec (§2.3).
- **Fallback:** None (see §4.4). Windsurf failure escalates to cluster authority.

---

## 5. Invariants Summary

The following invariants MUST hold at all times:

| Invariant | Description |
|---|---|
| **One-worker-per-child** | No child has more than one active worker at any time. |
| **Dispatch-before-checkpoint** | No dispatch occurs without a prior checkpoint write. |
| **Seal-before-dispatch** | The bootstrap seal is verified before every dispatch event. |
| **Packet immutability** | Packets are never modified after emission. |
| **Evidence-before-execution** | Assignment evidence is written before worker execution begins. |
| **Foreman-owns-lifecycle** | Only the Foreman advances child state. Workers emit results; the Foreman acts on them. |
| **Budget enforcement** | Dispatch stops when `children_completed >= max_children_per_session`. |
| **Escalation-on-failure** | Workers do not self-retry. All failure handling is the Foreman's responsibility. |

---

## 6. Related Specs

- `mcp-confirmed-dispatch-architecture.md` — MCP-to-runtime dispatch bridge
- `execution-adapters.md` — Adapter implementations for execution modes
- `windsurf-orchestrator.md` — Windsurf Cascade operator surface
- `provider-capability-matrix.md` — Provider capability comparison
- `current-state-schema.md` — Run state schema reference
