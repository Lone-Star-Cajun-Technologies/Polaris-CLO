# Delegated Dispatch Doctrine - Foreman Seal Resolution

## Status
candidate

## Problem

The Foreman/Orchestrator seal explicitly prohibits implementation work:

> **Prohibited Parent Actions:**
> - Writing or modifying source code, tests, or configuration
> - Browsing the repository filesystem
> - Interpreting the meaning of code or documentation
> - Engaging in conversational reasoning or planning outside of its state machine

However, the current "delegated" dispatch mode implies the orchestrator owns execution, creating a contradiction where the Foreman would need to perform worker responsibilities.

## Resolution

Redefine **delegated mode** to maintain strict separation:

| Concern | Owner | Foreman Role |
|---------|-------|--------------|
| Coordination | Foreman | ✅ SELECT child, DISPATCH packet, MONITOR status |
| Implementation | Worker | ❌ Foreman NEVER implements |
| Assignment | Foreman | ✅ Must spawn or assign worker, OR escalate |

## Updated Delegated Dispatch Contract

### Definition

```
delegated: The orchestrator owns coordination.
           The orchestrator does NOT own implementation.
           The orchestrator must either:
             1. Spawn or assign a worker, OR
             2. Escalate because no worker is available
```

### Prohibited (Seal Violation)

```
❌ Foreman receives packet
❌ Foreman implements issue
❌ Foreman modifies files
❌ Foreman marks child complete
```

### Required (Seal Compliant)

```
✅ Foreman selects child
✅ Foreman generates packet
✅ Foreman attempts worker assignment
✅ Foreman records assignment evidence
✅ Foreman monitors for worker heartbeats/results
✅ Foreman escalates if worker unavailable
```

## Runtime States for Delegated Mode

### Mode State Relationship

The dispatch system supports two mutually exclusive execution modes that determine which state machine governs a child's lifecycle:

**Direct-Worker Mode** (enabled when `--provider` is specified):
- Inherits the foundational worker execution states from the base dispatch contract
- States: `packet-created`, `launching`, `running`, `waiting-for-approval`, `blocked`, `completed`, `failed`, `orphaned`
- The Foreman delegates to an external worker process and monitors via heartbeats
- Transitions are driven by worker telemetry events (launch, heartbeat, result)

**Delegated Mode** (enabled when no `--provider` is specified):
- Introduces Foreman coordination states that extend but do not replace worker execution states
- States: `delegated`, `assigning`, `worker-assigned`, `waiting-for-worker`, `escalating`, `worker-unavailable`
- The Foreman attempts to spawn/assign a worker OR escalates if unavailable
- Once a worker is assigned (`worker-assigned`), the state may transition to Direct-Worker states

**Mode Transitions:**
- Initial dispatch without `--provider` → enters `delegated` state
- Foreman successfully assigns worker → transitions to `worker-assigned` then `launching` (Direct-Worker)
- Foreman fails to assign worker → transitions to `escalating` → `worker-unavailable`
- A child in `worker-unavailable` may be manually re-dispatched with `--provider` to enter Direct-Worker mode

### Worker-Managed States (Direct-Worker Mode Only)

These states require an external worker process:

| State | Meaning | Entered When |
|-------|---------|--------------|
| `packet-created` | Packet ready for handoff | Dispatch with provider specified |
| `launching` | Worker spawn initiated | Adapter confirms process start |
| `running` | Worker acknowledged | First heartbeat received |
| `waiting-for-approval` | Worker blocked | Block event in telemetry |
| `blocked` | Worker stale | No heartbeat within timeout |
| `completed` | Worker finished | Result file present |
| `failed` | Worker error | Error result or crash |
| `orphaned` | Worker lost | Extended heartbeat timeout |

### Delegated Mode States

These states reflect the Foreman's coordination role:

| State | Meaning | Entered When |
|-------|---------|--------------|
| `delegated` | Packet ready, awaiting assignment | Dispatch without provider |
| `assigning` | Foreman attempting worker assignment | Worker assignment initiated |
| `worker-assigned` | Worker confirmed assigned | Assignment evidence recorded |
| `waiting-for-worker` | Worker expected but not yet active | No heartbeat yet from assigned worker |
| `escalating` | No worker available | Assignment failed, escalating |
| `worker-unavailable` | No worker could be assigned | Escalation complete, human needed |

## Worker Assignment Evidence Requirements

### Minimum Evidence Required

To prove `Foreman dispatched worker` instead of `Foreman executed work`, the following evidence MUST be recorded:

```typescript
interface WorkerAssignmentEvidence {
  // Required
  event: "worker-assigned";
  dispatch_id: string;
  child_id: string;
  assigned_at: string;
  
  // Assignment mechanism (at least one required)
  assignment_type: "subagent" | "external-process" | "human-handoff" | "pending-escalation";
  
  // For subagent assignments
  subagent_session_id?: string;
  
  // For external process
  process_pid?: number;
  command?: string;
  
  // For human handoff
  handoff_token?: string;
  instructions_url?: string;
}
```

### Evidence Validation Rules

1. **Subagent assignment**: `subagent_session_id` must be non-empty
2. **External process**: `process_pid` must be > 0
3. **Human handoff**: `handoff_token` must be non-empty
4. **Pending escalation**: `assignment_type` must be `"pending-escalation"` with `escalation_reason`

## Telemetry Events

### Foreman Coordination Events

```typescript
// Delegated dispatch initiated
interface DelegatedDispatchedEvent {
  event: "delegated-dispatched";
  dispatch_id: string;
  child_id: string;
  packet_path: string;
  timestamp: string;
}

// Worker assignment attempted
interface WorkerAssignmentAttemptedEvent {
  event: "worker-assignment-attempted";
  dispatch_id: string;
  child_id: string;
  /**
   * Assignment type being attempted.
   * Note: "pending-escalation" is only used when the Foreman determines
   * immediately that no assignment is possible and escalation is required.
   */
  assignment_type: "subagent" | "external-process" | "human-handoff" | "pending-escalation";
  timestamp: string;
}

// Worker assigned (success)
interface WorkerAssignedEvent {
  event: "worker-assigned";
  dispatch_id: string;
  child_id: string;
  assignment_type: "subagent" | "external-process" | "human-handoff";
  subagent_session_id?: string;
  process_pid?: number;
  handoff_token?: string;
  timestamp: string;
}

// Worker assignment failed
interface WorkerAssignmentFailedEvent {
  event: "worker-assignment-failed";
  dispatch_id: string;
  child_id: string;
  reason: "no-subagent-support" | "process-spawn-failed" | "provider-unavailable" | "timeout";
  timestamp: string;
}

// Escalation initiated
interface EscalationInitiatedEvent {
  event: "escalation-initiated";
  dispatch_id: string;
  child_id: string;
  reason: string;
  recommended_action: "manual-dispatch" | "provider-config" | "subagent-enable";
  timestamp: string;
}
```

## Provider Capability Handling

### Gemini Supports Subagents

```
1. Foreman checks: Does Gemini support subagents?
2. Yes: Attempt subagent spawn
3. Subagent spawn succeeds:
   - Record worker-assigned
   - Transition: delegated → assigning → worker-assigned → waiting-for-worker
4. Subagent spawn fails:
   - Record worker-assignment-failed
   - Escalate: delegated → escalating → worker-unavailable
```

### Gemini Does Not Support Subagents

```
1. Foreman checks: Does Gemini support subagents?
2. No: Skip to escalation
3. Escalation:
   - Record escalation-initiated
   - Status shows: worker-unavailable
   - Message: "No subagent support. Manual dispatch required."
```

### Unknown Provider Capabilities

```
1. Foreman checks: Are capabilities known?
2. Unknown: Attempt discovery
3. Discovery succeeds: Proceed based on capability
4. Discovery fails: Conservative escalation
   - Status: worker-unavailable
   - Message: "Provider capabilities unknown. Manual dispatch required."
```

## Foreman Seal Compliance Verification

### Compliance Checklist

| Check | Pass | Fail |
|-------|------|------|
| Foreman modified files? | ❌ No evidence | 🚫 VIOLATION |
| Foreman wrote implementation? | ❌ No evidence | 🚫 VIOLATION |
| Foreman assigned worker? | ✅ Evidence exists | ⚠️ Missing |
| Worker executed implementation? | ✅ Evidence exists | ⚠️ Missing |
| Escalation documented? | ✅ If no worker | N/A |

### Violation Detection

The runtime MUST detect and block Foreman seal violations using only documented telemetry events:

```typescript
interface Violation {
  type: "foreman-seal-violation";
  description: string;
  evidence: WorkerTelemetryEvent;
  action: "block-and-escalate" | "audit-required";
}

function detectForemanViolation(events: WorkerTelemetryEvent[]): Violation | null {
  // Sort events by timestamp for chronological analysis
  const sorted = [...events].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  // Check for child completion without worker assignment
  // This is detected by finding a "worker-result" event without a preceding "worker-assigned"
  const workerResults = sorted.filter(e => e.event === "worker-result");
  const workerAssignedEvents = sorted.filter(e => e.event === "worker-assigned");

  for (const result of workerResults) {
    // Check if this result has a corresponding worker-assigned event
    const hasAssignment = workerAssignedEvents.some(
      assigned => new Date(assigned.timestamp).getTime() < new Date(result.timestamp).getTime()
    );

    if (!hasAssignment) {
      return {
        type: "foreman-seal-violation",
        description: "Child completed without worker assignment evidence",
        evidence: result,
        action: "audit-required"
      };
    }
  }

  // Check for direct Foreman implementation via dispatch boundary violations
  // This is detected by "invalid-inline-attempt" events which indicate
  // the Foreman tried to execute work without proper dispatch
  const inlineAttempts = sorted.filter(e => e.event === "invalid-inline-attempt");

  for (const attempt of inlineAttempts) {
    // If there's an invalid-inline-attempt but no subsequent worker-assigned,
    // the Foreman may have completed the work inline (seal violation)
    const subsequentAssignment = workerAssignedEvents.some(
      assigned => new Date(assigned.timestamp).getTime() > new Date(attempt.timestamp).getTime()
    );

    if (!subsequentAssignment) {
      return {
        type: "foreman-seal-violation",
        description: "Foreman may have performed implementation work (no worker assignment after inline attempt)",
        evidence: attempt,
        action: "block-and-escalate"
      };
    }
  }

  return null;
}
```

## Implementation Changes Required

### 1. Runtime State Model Update

Add delegated-mode-specific states to `src/loop/checkpoint.ts`:

```typescript
export type DelegatedRuntimeState =
  | "delegated"          // Packet ready, awaiting assignment
  | "assigning"          // Attempting worker assignment
  | "worker-assigned"    // Worker confirmed assigned
  | "waiting-for-worker" // Worker expected but not yet active
  | "escalating"         // No worker available, escalating
  | "worker-unavailable"; // Escalation complete, human needed
```

### 2. Dispatch Record Enhancement

Add assignment evidence tracking:

```typescript
interface WorkerAssignmentRecord {
  assigned_at: string;
  assignment_type: "subagent" | "external-process" | "human-handoff" | "pending-escalation";
  subagent_session_id?: string;
  process_pid?: number;
  handoff_token?: string;
  escalation_reason?: string;
}
```

### 3. Telemetry Event Definitions

Add events to `src/loop/dispatch-state.ts`:

```typescript
export interface WorkerAssignmentAttemptedEvent extends WorkerTelemetryEventBase {
  event: "worker-assignment-attempted";
  assignment_type: string;
}

export interface WorkerAssignedEvent extends WorkerTelemetryEventBase {
  event: "worker-assigned";
  assignment_type: string;
  subagent_session_id?: string;
  process_pid?: number;
}

export interface WorkerAssignmentFailedEvent extends WorkerTelemetryEventBase {
  event: "worker-assignment-failed";
  reason: string;
}

export interface EscalationInitiatedEvent extends WorkerTelemetryEventBase {
  event: "escalation-initiated";
  reason: string;
  recommended_action: string;
}
```

### 4. Status Display Update

Update `src/loop/status.ts` to show delegated-mode states:

```
Mode:             delegated
Runtime state:    worker-unavailable
Assignment:       none (no subagent support)
Action required:  Manual dispatch with --provider
Packet:           .polaris/clusters/POL-123/packets/POL-203-xxx.json
```

### 5. Minimal Implementation Scope

**Phase 1 (Immediate):**
- Add `worker-assignment-attempted`, `worker-assigned`, `worker-assignment-failed`, `escalation-initiated` events
- Update status to show meaningful delegated states
- Add validation: child completion requires worker-assigned OR escalation-initiated

**Phase 2 (Next):**
- Add Foreman violation detection
- Implement escalation workflow
- Add provider capability discovery

**Phase 3 (Future):**
- Automated escalation handling
- Subagent auto-detection
- Worker pool integration

## Example Status Outputs

### Worker Successfully Assigned

```
Dispatch Evidence:
  Child:            POL-203
  Mode:             delegated
  Runtime state:    worker-assigned
  Assignment:       subagent (session: gem-abc-123)
  Assigned at:      2026-05-29T14:30:00.000Z
  Packet:           .polaris/clusters/POL-123/packets/POL-203-xxx.json
  Expected result:  .polaris/clusters/POL-123/results/POL-203-xxx.json
```

### Worker Unavailable (No Subagent Support)

```
Dispatch Evidence:
  Child:            POL-203
  Mode:             delegated
  Runtime state:    worker-unavailable
  Assignment:       none (no subagent support detected)
  
  ⚠️  Worker unavailable - Foreman cannot implement (seal violation would occur)
  
  Action required:
    1. Manual worker dispatch: polaris loop dispatch --child POL-203 --provider <name>
    2. Or enable subagent support in your environment
    3. Or delegate to external worker manually
  
  Packet ready at:  .polaris/clusters/POL-123/packets/POL-203-xxx.json
```

### Waiting for Worker (Assignment Made, No Heartbeat Yet)

```
Dispatch Evidence:
  Child:            POL-203
  Mode:             delegated
  Runtime state:    waiting-for-worker
  Assignment:       subagent (session: gem-abc-123)
  Assigned at:      2026-05-29T14:30:00.000Z
  
  ⏳ Worker assigned but not yet active
  
  Last heartbeat:   (none yet)
  Packet:           .polaris/clusters/POL-123/packets/POL-203-xxx.json
```

## Summary

This doctrine resolves the Foreman seal conflict by:

1. **Clarifying boundaries**: Foreman coordinates, workers implement
2. **Adding evidence requirements**: Worker assignment must be provable
3. **Defining delegated states**: Reflect coordination progress, not implementation
4. **Providing escalation path**: When workers unavailable, escalate don't violate
5. **Enabling violation detection**: Runtime can detect and block seal violations

The Foreman remains a thin orchestrator. Implementation always belongs to workers.
