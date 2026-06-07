<!-- polaris:doctrine-superseded -->
<!-- SUPERSEDED: The dispatch model described here (loop dispatch --provider / loop continue)
     has been replaced by the batch loop run command. Do not copy CLI examples from this file.
     Current dispatch path: npm run polaris -- loop run <cluster-id>
     See .polaris/skills/polaris-run/chain.md for authoritative dispatch instructions. -->

# Worker Dispatch Contract Specification

## Version
1.0.0-draft (SUPERSEDED)

## Problem Statement

Polaris currently conflates "packet written" with "worker dispatched". This creates an architectural gap where:

1. No worker is actually invoked unless the active agent manually does so
2. Polaris cannot distinguish between:
   - A packet waiting for handoff
   - A worker process launching
   - A worker actively executing
   - A worker that crashed before emitting heartbeats
3. Provider selection is config-time, not dispatch-time
4. No lifecycle state machine for worker execution

## Goals

1. Define clear semantic boundaries for dispatch states
2. Support explicit provider routing per dispatch
3. Enable provider-agnostic dispatch (works for Gemini, Copilot, Codex, Windsurf, future)
4. Distinguish Polaris-launched workers from agent-internal subagents
5. Integrate heartbeats, approval telemetry, and results with dispatch state
6. Preserve provider-specific subagent capabilities where appropriate

---

## 1. What "Dispatched" Means

### The Dispatch Lifecycle

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  packet-created │ ──▶ │    delegated     │ ──▶ │    launching     │
│  (packet file   │     │  (provider known,│     │  (process start  │
│   exists)       │     │   ready to send) │     │   signal)        │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                                                          │
                           ┌────────────────────────────────┘
                           ▼
                    ┌──────────────────┐     ┌──────────────────┐
                    │    running       │ ──▶ │ waiting-for-     │
                    │  (first          │     │   approval       │
                    │   heartbeat)     │     │                  │
                    └──────────────────┘     └──────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   completed  │   │    failed    │   │   orphaned   │
│  (result     │   │  (error or   │   │ (heartbeat  │
│   received)  │   │   crash)     │   │  timeout)   │
└──────────────┘   └──────────────┘   └──────────────┘
```

### State Definitions

| State | Definition | Entry Event | Proof Required |
|-------|------------|-------------|----------------|
| `packet-created` | Packet file written, no worker associated yet | `polaris loop dispatch` without provider | Packet file exists |
| `delegated` | Provider assigned, ready for handoff | Provider selection (explicit or config) | Provider field populated |
| `launching` | Worker process spawn initiated | Adapter receives dispatch call | Process PID or spawn timestamp |
| `running` | Worker acknowledged packet, first heartbeat received | Worker heartbeat with `step_cursor: "start"` | Heartbeat event in telemetry |
| `waiting-for-approval` | Worker blocked on approval request | `worker-blocked` event emitted | Blocked event in telemetry |
| `blocked` | Worker stuck, not making progress | No heartbeat timeout | Last heartbeat timestamp |
| `completed` | Worker finished successfully | Result file written or compact return | Result data exists |
| `failed` | Worker finished with error or crashed | Error result or process error exit | Error result data |
| `orphaned` | Worker lost, no telemetry for timeout period | Heartbeat timeout exceeded | No heartbeat > threshold |

---

## 2. Polaris Behavior Without Explicit Worker

### Option A: Active Orchestrator Owns the Child (Default)

When no worker is explicitly configured:

1. Polaris writes the packet
2. Polaris marks child as `delegated` with provider `orchestrator`
3. Polaris pauses with message: "Packet ready. Execute: polaris loop work --packet <path>"
4. The active orchestrator session can claim the work:
   ```bash
   polaris loop work --packet .polaris/clusters/POL-123/packets/POL-124-xxx.json
   ```
5. This transitions state to `running` (same-agent execution)

### Option B: Polaris Stops After Packet Generation

With `--delegate-only` flag:

1. Polaris writes packet
2. Polaris records dispatch with status `packet-created`
3. Polaris exits cleanly with packet path in stdout
4. External system is responsible for launching worker

### Option C: Polaris Marks Child as Delegated (External)

With explicit provider:

1. Polaris writes packet
2. Polaris marks provider and transitions to `delegated`
3. External orchestrator monitors and launches worker
4. Worker reports status via telemetry

---

## 3. Explicit Worker Routing

### Provider Selection Priority

```
1. CLI flag: --provider <name>
2. Environment: POLARIS_PROVIDER=<name>
3. Config role: execution.roles.worker.provider
4. Config rotation: execution.rotation[0]
5. Config default: first provider in execution.providers
```

### Per-Dispatch Provider Override

```bash
# Run POL-203 with Copilot
polaris loop dispatch --child POL-203 --provider copilot

# Run POL-203 with Gemini
polaris loop dispatch --child POL-203 --provider gemini

# Run POL-203 with Codex
polaris loop dispatch --child POL-203 --provider codex
```

### Provider-Specific Dispatch

Each provider has different capabilities:

| Provider | Dispatch Mechanism | Heartbeat Support | Approval Integration |
|----------|-------------------|-------------------|---------------------|
| Claude (Windsurf) | Agent subtask | Native via progress API | Native approval UI |
| Copilot | LSP/Agent protocol | Extension heartbeat | VS Code approval |
| Codex | CLI spawn | File-based telemetry | Manual (external) |
| Gemini | CLI spawn | File-based telemetry | Manual (external) |

---

## 4. Visibility: Polaris-Launched vs Agent-Internal

### Polaris-Launched Workers

Characteristics:
- Spawned by `polaris loop dispatch` via adapter
- Packet path in `.polaris/clusters/<cluster>/packets/`
- Result expected in `.polaris/clusters/<cluster>/results/`
- Telemetry written to shared `.taskchain_artifacts/.../telemetry.jsonl`
- Heartbeats integrate with `polaris loop status`

### Agent-Internal Subagents

Characteristics:
- Spawned by agent's own subtask mechanism
- May not use Polaris packet format
- May not write to Polaris telemetry
- Invisible to `polaris loop status`
- Cannot be tracked by Polaris runtime

### Hybrid Mode: Polaris-Tracked, Agent-Spawned

Best of both worlds:
- Agent subtask is spawned internally
- But agent writes Polaris-format heartbeats
- Agent writes to shared telemetry file
- Polaris tracks via telemetry, not process

---

## 5. Runtime State Machine

### State Transitions

```
packet-created ──(provider assigned)──▶ delegated ──(process spawn)──▶ launching
     │                                                                          │
     │                                                                          │
     └──────────(same-agent claim)──────────▶ running ◀───────────────────────────┘
                                                  │
                         ┌────────────────────────┼────────────────────────┐
                         │                        │                        │
                         ▼                        ▼                        ▼
               waiting-for-approval            completed                  failed
                         │
                         ▼
                      blocked
                         │
                         ▼
                     orphaned (after timeout)
```

### Transition Events

| From | To | Trigger | Required Data |
|------|-----|---------|---------------|
| - | `packet-created` | `polaris loop dispatch` | Packet file path |
| `packet-created` | `delegated` | Provider assignment | Provider name |
| `delegated` | `launching` | Adapter dispatch() called | Process PID |
| `launching` | `running` | First heartbeat received | Heartbeat timestamp |
| `running` | `waiting-for-approval` | Worker blocked event | Blocker ID, reason |
| `waiting-for-approval` | `running` | Approval granted | Approval timestamp |
| `waiting-for-approval` | `failed` | Approval denied / timeout | Denial reason |
| `running` | `completed` | Result received, exit 0 | Result data |
| `running` | `failed` | Result received, exit non-0 | Error data |
| `running` | `blocked` | Heartbeat timeout | Last heartbeat time |
| `blocked` | `orphaned` | Extended timeout | Timeout threshold |
| `blocked` | `running` | Heartbeat resumes | New heartbeat |
| *any* | `failed` | Process crash / signal | Exit code |

---

## 6. Worker "Alive" Proof

### Primary Evidence: Heartbeat

The definitive proof of worker life is a **heartbeat event**:

```typescript
interface WorkerHeartbeat {
  event: "worker-heartbeat";
  run_id: string;
  child_id: string;
  dispatch_id: string;
  step_cursor: string;
  timestamp: string;  // ISO 8601
  progress_pct?: number;
  files_changed?: number;
  current_file?: string;
  provider?: string;
}
```

### Secondary Evidence

| Evidence | When Valid | Limitations |
|----------|------------|-------------|
| Process launch | `launching` state | Process may crash immediately |
| Approval request | `waiting-for-approval` | Worker alive but blocked |
| Result file | `completed` or `failed` | Terminal state, no longer "alive" |
| Process heartbeat (adapter-level) | During adapter-specific dispatch | Only works for some adapters |

### Timeout Configuration

```typescript
interface WorkerTimeoutConfig {
  /** Time after launching before first heartbeat expected */
  launch_to_first_heartbeat_ms: number;
  
  /** Time between heartbeats before worker considered blocked */
  heartbeat_interval_ms: number;
  
  /** Time after last heartbeat before worker considered orphaned */
  orphan_timeout_ms: number;
  
  /** Time waiting for approval before auto-fail */
  approval_timeout_ms: number;
}

const DEFAULT_TIMEOUTS: WorkerTimeoutConfig = {
  launch_to_first_heartbeat_ms: 30000,   // 30 seconds
  heartbeat_interval_ms: 300000,         // 5 minutes
  orphan_timeout_ms: 600000,             // 10 minutes
  approval_timeout_ms: 3600000,          // 1 hour
};
```

---

## 7. Heartbeat, Approval, and Result Integration

### Telemetry Event Types

```typescript
type WorkerTelemetryEvent =
  | WorkerHeartbeat
  | WorkerBlockedEvent
  | WorkerAutoApprovedEvent
  | WorkerManualApprovedEvent
  | WorkerResultEvent
  | WorkerLaunchEvent;

// Launch confirmation
interface WorkerLaunchEvent {
  event: "worker-launch";
  run_id: string;
  child_id: string;
  dispatch_id: string;
  provider: string;
  adapter: string;
  pid?: number;
  timestamp: string;
}

// Blocked waiting for approval
interface WorkerBlockedEvent {
  event: "worker-blocked";
  run_id: string;
  child_id: string;
  dispatch_id: string;
  reason: "needs-approval" | "approval-timeout" | "error" | "unknown";
  approval_type?: "destructive" | "cost" | "security" | "ambiguous" | "external";
  description: string;
  blocker_id: string;
  timestamp: string;
}

// Auto-approved by worker policy
interface WorkerAutoApprovedEvent {
  event: "worker-auto-approved";
  run_id: string;
  child_id: string;
  dispatch_id: string;
  approval_type: "destructive" | "cost" | "security" | "ambiguous" | "external";
  description: string;
  policy_applied: string;
  timestamp: string;
}

// Manually approved by operator
interface WorkerManualApprovedEvent {
  event: "worker-manual-approved";
  run_id: string;
  child_id: string;
  dispatch_id: string;
  blocker_id: string;
  approved_by: string;
  timestamp: string;
}

// Worker result (success or failure)
interface WorkerResultEvent {
  event: "worker-result";
  run_id: string;
  child_id: string;
  dispatch_id: string;
  status: "success" | "failure" | "blocked";
  exit_code?: number;
  result_file?: string;
  compact_return?: Record<string, unknown>;
  timestamp: string;
}
```

### Integration with Dispatch State

The telemetry events drive state transitions:

```typescript
function deriveDispatchState(
  dispatchRecord: ChildDispatchRecord,
  events: WorkerTelemetryEvent[],
  config: WorkerTimeoutConfig,
  now: Date
): WorkerDispatchState {
  const sorted = events.sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  const latest = sorted.at(-1);
  const heartbeats = sorted.filter(e => e.event === "worker-heartbeat");
  const lastHeartbeat = heartbeats.at(-1);
  
  // Check for result first (terminal states)
  const resultEvent = sorted.find(e => e.event === "worker-result") as WorkerResultEvent | undefined;
  if (resultEvent) {
    return resultEvent.status === "success" ? "completed" : "failed";
  }
  
  // Check for blocked
  const blockedEvent = sorted.find(e => e.event === "worker-blocked") as WorkerBlockedEvent | undefined;
  if (blockedEvent) {
    const approvedAfter = sorted.find(e => 
      (e.event === "worker-manual-approved" || e.event === "worker-auto-approved") &&
      new Date(e.timestamp) > new Date(blockedEvent.timestamp)
    );
    if (!approvedAfter) {
      const blockedMs = now.getTime() - new Date(blockedEvent.timestamp).getTime();
      if (blockedMs > config.approval_timeout_ms) {
        return "failed";
      }
      return "waiting-for-approval";
    }
  }
  
  // Check heartbeat freshness
  if (lastHeartbeat) {
    const msSinceHeartbeat = now.getTime() - new Date(lastHeartbeat.timestamp).getTime();
    if (msSinceHeartbeat > config.orphan_timeout_ms) {
      return "orphaned";
    }
    if (msSinceHeartbeat > config.heartbeat_interval_ms) {
      return "blocked";
    }
  }
  
  // Check launch status
  const launchEvent = sorted.find(e => e.event === "worker-launch") as WorkerLaunchEvent | undefined;
  if (launchEvent && !lastHeartbeat) {
    const msSinceLaunch = now.getTime() - new Date(launchEvent.timestamp).getTime();
    // Check orphan timeout first (longer threshold)
    if (msSinceLaunch > config.orphan_timeout_ms) {
      return "orphaned"; // Worker launched but never sent heartbeat - considered orphaned
    }
    if (msSinceLaunch > config.launch_to_first_heartbeat_ms) {
      return "blocked"; // Launch but no heartbeat (within orphan window)
    }
    return "launching";
  }
  
  // Default: delegated (provider assigned but not launched)
  return dispatchRecord.provider ? "delegated" : "packet-created";
}
```

---

## 8. Required Packet Fields

### Enhanced WorkerPacket

```typescript
interface WorkerPacket extends BootstrapPacket {
  schema_version: '2.1';  // Bumped for dispatch contract
  
  // Existing fields (unchanged)
  run_id: string;
  cluster_id: string;
  active_child: string;
  state_file: string;
  telemetry_file: string;
  
  // NEW: Dispatch contract fields
  dispatch_id: string;
  provider: string;
  adapter: string;
  
  // NEW: Expected lifecycle events
  expected_heartbeats: {
    initial_interval_ms: number;
    ongoing_interval_ms: number;
  };
  
  // NEW: Result contract
  result_contract: {
    result_file: string;
    expected_fields: string[];
    deadline_ms: number;
  };
  
  // NEW: Approval policy for this dispatch
  approval_policy?: {
    auto_approve?: ("destructive" | "cost" | "security")[];
    require_manual?: ("destructive" | "cost" | "security")[];
  };
  
  // Existing fields (unchanged)
  worker_role: WorkerRole;
  instructions: CompiledSteps;
  lifecycle: WorkerLifecycleContract;
  return_contract: string[];
  result_file_contract?: SealedResultFileContract;
  prompt_mode: WorkerPromptMode;
  prompt_metrics: WorkerPromptMetrics;
  context?: Record<string, unknown>;
}
```

### ChildDispatchRecord Update

```typescript
interface ChildDispatchRecord {
  dispatch_id: string;
  child_id: string;
  run_id: string;
  cluster_id: string;
  packet_path: string;
  expected_result_path: string;
  provider: string;  // Now REQUIRED
  adapter: string;   // NEW
  dispatched_at: string;
  
  // NEW: Explicit state tracking
  status: WorkerDispatchState;
  
  // NEW: State transition timestamps
  state_history: {
    state: WorkerDispatchState;
    entered_at: string;
    evidence?: string;  // Event ID or process PID
  }[];
  
  // NEW: Last known activity
  last_heartbeat_at?: string;
  last_heartbeat_step?: string;
  
  // NEW: Launch evidence
  launch_pid?: number;
  launch_adapter?: string;
}
```

---

## 9. Required Heartbeat Fields

### Core Heartbeat Schema

```typescript
interface WorkerHeartbeat {
  // Event identity
  event: "worker-heartbeat";
  event_id: string;           // NEW: Unique for deduplication
  
  // Dispatch correlation
  dispatch_id: string;        // NEW: Links to dispatch record
  run_id: string;
  child_id: string;
  
  // Progress information
  step_cursor: string;
  step_detail?: string;
  
  // Metrics (optional but recommended)
  progress_pct?: number;      // 0-100
  files_changed?: number;
  lines_added?: number;
  lines_deleted?: number;
  current_file?: string;
  tokens_used?: number;
  
  // Provider-specific (optional)
  provider?: string;
  model?: string;
  
  // Timing
  timestamp: string;          // ISO 8601
  elapsed_ms?: number;        // Time since worker start
}
```

### Heartbeat Requirements

1. **Initial heartbeat**: Within 30 seconds of worker start
2. **Ongoing heartbeats**: Every 5 minutes during active work
3. **Step changes**: Immediately on step_cursor transition
4. **File operations**: Optional, emit after significant changes
5. **Final heartbeat**: Before writing result

---

## 10. Required Approval Telemetry Fields

### Blocked Event Schema

```typescript
interface WorkerBlockedEvent {
  event: "worker-blocked";
  event_id: string;
  
  // Correlation
  dispatch_id: string;
  run_id: string;
  child_id: string;
  
  // Block details
  blocker_id: string;         // Unique ID for this blocker
  reason: "needs-approval" | "approval-timeout" | "error" | "unknown";
  approval_type: "destructive" | "cost" | "security" | "ambiguous" | "external";
  
  // Human-readable
  description: string;
  suggested_action?: string;
  
  // Context for decision
  affected_files?: string[];
  command_preview?: string;
  cost_estimate?: string;
  
  // Policy context
  policy_id?: string;         // Which policy triggered this
  auto_approve_eligible?: boolean;
  
  timestamp: string;
}
```

### Approval Resolution Events

```typescript
interface WorkerApprovedEvent {
  event: "worker-approved" | "worker-rejected";
  event_id: string;
  
  // Correlation
  dispatch_id: string;
  blocker_id: string;
  
  // Resolution
  resolution: "approved" | "rejected" | "timed-out";
  approved_by?: "operator" | "policy" | "timeout";
  
  // Context
  operator_id?: string;       // Who approved (if manual)
  policy_applied?: string;    // Which policy auto-approved
  
  // Rejection details
  rejection_reason?: string;
  
  timestamp: string;
}
```

---

## 11. Required Result Contract

### Result File Schema

```typescript
interface SealedWorkerResult {
  // Correlation
  run_id: string;
  child_id: string;
  dispatch_id: string;      // NEW
  
  // Status
  status: "success" | "failure" | "in-progress";
  
  // Execution details
  exit_code: number;
  step_cursor: string;
  
  // Git outcome (for impl workers)
  commit?: string;
  commit_message?: string;
  
  // Validation
  validation: {
    status: "passed" | "failed" | "skipped";
    commands_run: string[];
    failure_details?: string;
  };
  
  // Delivery (for finalize workers)
  pr_url?: string;
  
  // Error details (on failure)
  error?: {
    message: string;
    code?: string;
    stack?: string;
    recoverable: boolean;
  };
  
  // Metrics
  metrics: {
    duration_ms: number;
    heartbeats_emitted: number;
    files_modified: number;
    tokens_used?: number;
  };
  
  // Next action recommendation
  next_recommended_action: "continue" | "stop" | "investigate" | "retry";
  
  // Legacy: additional data
  result_data?: Record<string, unknown>;
  
  // Timestamps
  started_at: string;
  completed_at: string;
}
```

---

## 12. Implementation Plan

### Phase 1: Core State Machine (Week 1)

1. **Define types** (`src/loop/dispatch-state.ts`)
   - `WorkerDispatchState` enum
   - `ChildDispatchRecord` v2
   - State transition functions

2. **Update checkpoint** (`src/loop/checkpoint.ts`)
   - Add `state_history` to dispatch record
   - Add `dispatch_id` generation
   - Add validation for new fields

3. **Enhance dispatch** (`src/loop/dispatch.ts`)
   - Add `--provider` CLI flag
   - Write enhanced packet with dispatch_id
   - Record provider in dispatch record
   - Support `--delegate-only` mode

### Phase 2: Telemetry Integration (Week 2)

1. **Define event schemas** (`src/loop/telemetry-events.ts`)
   - All heartbeat, blocked, approval, result events
   - Validation functions

2. **Update worker packet** (`src/loop/worker-packet.ts`)
   - Add dispatch_id to packet
   - Add expected_heartbeats
   - Add result_contract

3. **Enhance worker** (`src/loop/worker.ts`)
   - Emit `worker-launch` event
   - Emit heartbeats at each step
   - Emit result event

### Phase 3: State Derivation (Week 2-3)

1. **Create state machine** (`src/loop/dispatch-state-machine.ts`)
   - `deriveDispatchState()` function
   - Timeout checking
   - Transition validation

2. **Update status** (`src/loop/status.ts`)
   - Show derived dispatch state
   - Show state history
   - Highlight orphaned workers

3. **Add monitoring** (`src/loop/monitor.ts` - NEW)
   - Background check for orphaned workers
   - Alert on stale dispatches

### Phase 4: Provider Routing (Week 3-4)

1. **Update adapters** (`src/loop/adapters/`)
   - Pass dispatch_id through all adapters
   - Record launch events
   - Support provider-specific heartbeat patterns

2. **Enhance CLI** (`src/cli/`)
   - `polaris loop dispatch --provider <name>`
   - `polaris loop work --packet <path>` (claim work)
   - `polaris loop monitor` (watch for orphans)

3. **Config updates** (`src/config/schema.ts`)
   - Add `execution.timeout` config section
   - Add per-provider timeout overrides

### Phase 5: Provider Integrations (Week 4-6)

1. **Windsurf/Claude adapter** (enhancement)
   - Native heartbeat integration
   - Native approval flow integration

2. **Copilot adapter** (NEW)
   - LSP-based dispatch
   - Extension heartbeat

3. **Generic CLI adapters** (Codex, Gemini)
   - File-based heartbeat polling
   - External approval handling

### Phase 6: Testing & Hardening (Week 6-8)

1. **Unit tests**
   - State machine transitions
   - Timeout detection
   - Event validation

2. **Integration tests**
   - End-to-end dispatch lifecycle
   - Provider-specific flows
   - Orphan detection

3. **Documentation**
   - Update Polaris.md files
   - Provider integration guides
   - Troubleshooting guide

---

## 13. Migration Path

### For Existing Runs

1. Legacy states without `dispatch_id` are treated as `completed` or `failed`
2. States with packet but no provider are treated as `packet-created`
3. No migration needed for existing completed runs

### For New Runs

1. All dispatches use new v2.1 packet schema
2. All dispatches include dispatch_id
3. State machine tracking is automatic

---

## 14. Configuration Example

```json
{
  "execution": {
    "adapter": "terminal-cli",
    "providers": {
      "claude": { "command": "claude", "args": ["--print", "{{packet_file}}"] },
      "codex": { "command": "codex", "args": ["{{packet_file}}"] },
      "gemini": { "command": "gemini", "args": ["--prompt", "{{packet_file}}"] },
      "copilot": { "command": "copilot", "args": ["-p", "{{packet_file}}", "--autopilot"] }
    },
    "rotation": ["claude", "codex"],
    "timeout": {
      "launch_to_heartbeat_ms": 30000,
      "heartbeat_interval_ms": 300000,
      "orphan_timeout_ms": 600000,
      "approval_timeout_ms": 3600000,
      "per_provider": {
        "codex": { "launch_to_heartbeat_ms": 60000 },
        "gemini": { "launch_to_heartbeat_ms": 60000 }
      }
    },
    "roles": {
      "worker": { "provider": "claude" },
      "startup": { "provider": "claude" },
      "finalizer": { "provider": "claude" }
    }
  }
}
```

---

## A. Open Questions

1. **Process-level tracking**: Should Polaris attempt to track actual OS processes for terminal-cli adapter, or rely purely on telemetry?

2. **Approval UI**: Should Polaris provide a built-in approval UI for manual providers, or is external approval sufficient?

3. **Cross-provider retries**: If a worker fails with provider A, should Polaris support automatic retry with provider B?

4. **Subagent visibility**: Should agent-internal subagents be "opt-in" tracked (via telemetry) or remain invisible?

5. **Heartbeat frequency**: Should heartbeats be configurable per-provider based on their typical execution speed?

---

## B. Appendix: Event Examples

### Worker Launch Event
```json
{
  "event": "worker-launch",
  "event_id": "evt-123e4567-e89b-12d3-a456-426614174000",
  "dispatch_id": "dsp-550e8400-e29b-41d4-a716-446655440000",
  "run_id": "pol-5-session-1",
  "child_id": "POL-203",
  "provider": "copilot",
  "adapter": "terminal-cli",
  "pid": 12345,
  "timestamp": "2026-05-29T14:30:00.000Z"
}
```

### Worker Heartbeat
```json
{
  "event": "worker-heartbeat",
  "event_id": "evt-223e4567-e89b-12d3-a456-426614174001",
  "dispatch_id": "dsp-550e8400-e29b-41d4-a716-446655440000",
  "run_id": "pol-5-session-1",
  "child_id": "POL-203",
  "step_cursor": "implement",
  "step_detail": "src/loop/dispatch.ts",
  "progress_pct": 45,
  "files_changed": 3,
  "current_file": "src/loop/dispatch.ts",
  "timestamp": "2026-05-29T14:35:00.000Z",
  "elapsed_ms": 300000
}
```

### Worker Blocked Event
```json
{
  "event": "worker-blocked",
  "event_id": "evt-323e4567-e89b-12d3-a456-426614174002",
  "dispatch_id": "dsp-550e8400-e29b-41d4-a716-446655440000",
  "run_id": "pol-5-session-1",
  "child_id": "POL-203",
  "blocker_id": "blk-abc123",
  "reason": "needs-approval",
  "approval_type": "destructive",
  "description": "Worker requests permission to delete 15 files in src/legacy/",
  "affected_files": ["src/legacy/*.ts"],
  "auto_approve_eligible": false,
  "timestamp": "2026-05-29T14:40:00.000Z"
}
```

### Worker Result Event
```json
{
  "event": "worker-result",
  "event_id": "evt-423e4567-e89b-12d3-a456-426614174003",
  "dispatch_id": "dsp-550e8400-e29b-41d4-a716-446655440000",
  "run_id": "pol-5-session-1",
  "child_id": "POL-203",
  "status": "success",
  "exit_code": 0,
  "result_file": ".polaris/clusters/POL-123/results/POL-203-dsp-550e8400.json",
  "timestamp": "2026-05-29T14:50:00.000Z"
}
```
