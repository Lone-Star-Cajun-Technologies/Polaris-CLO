---
source: smartdocs/raw/worker-dispatch-contract-SUMMARY.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-06-04-019
classified-as: architecture
linked-map-area: src/loop
ingested-at: 2026-06-04T06:35:42.909Z
status: raw
---

# Worker Dispatch Contract - Summary

## Problem Identified

Polaris conflates **"packet written"** with **"worker dispatched"**, creating a runtime gap where no worker is actually invoked unless the active agent manually does so.

## Core Decisions

### 1. What "Dispatched" Means

**Dispatch is a lifecycle, not an event:**

| State | Meaning |
|-------|---------|
| `packet-created` | Packet file exists, no worker yet |
| `delegated` | Provider assigned, ready to handoff |
| `launching` | Worker process spawn initiated |
| `running` | First heartbeat received, worker alive |
| `waiting-for-approval` | Worker blocked, needs human decision |
| `blocked` | No heartbeat within expected window |
| `completed` | Worker finished successfully |
| `failed` | Worker error or crash |
| `orphaned` | Worker lost, no telemetry > threshold |

### 2. No-Worker Behavior

When no worker is explicitly configured, Polaris offers three modes:

- **Option A (Default)**: Active orchestrator owns the child via `polaris loop work --packet <path>`
- **Option B (Delegate)**: Polaris writes packet, exits cleanly, external system launches worker
- **Option C (External)**: Provider assigned but not launched, external orchestrator monitors via telemetry

### 3. Explicit Provider Routing

Per-dispatch provider selection (CLI examples):

```bash
polaris loop dispatch --child POL-203 --provider copilot
polaris loop dispatch --child POL-203 --provider gemini
polaris loop dispatch --child POL-203 --provider codex
```

Provider selection priority:
1. CLI flag: `--provider <name>`
2. Environment: `POLARIS_PROVIDER=<name>`
3. Config role: `execution.roles.worker.provider`
4. Config rotation: `execution.rotation[0]`
5. Config default: first provider in `execution.providers`

### 4. Visibility Model

| Worker Type | Spawned By | Packet Location | Telemetry | Heartbeats |
|-------------|------------|-----------------|-----------|------------|
| Polaris-launched | `polaris loop dispatch` | `.polaris/clusters/<cluster>/packets/` | Shared telemetry file | Integrated with `polaris loop status` |
| Agent-internal | Agent subtask | N/A (agent-specific) | May not write | Not tracked |
| Hybrid | Agent subtask | `.polaris/...` (writes format) | Shared telemetry | Tracked via telemetry |

### 5. Event Proves Worker Alive

**Primary evidence**: Heartbeat event
```typescript
{
  event: "worker-heartbeat",
  dispatch_id: "dsp-550e8400...",
  step_cursor: "implement",
  timestamp: "2026-05-29T14:35:00.000Z"
}
```

**Secondary evidence** (in order of reliability):
1. Process launch (adapter-specific) — worker may crash immediately
2. Approval request — worker alive but blocked
3. Result file — terminal state, no longer "alive"

### 6. Integration Points

- **Heartbeats**: Drive `running`/`blocked`/`orphaned` states
- **Approval events**: Drive `waiting-for-approval` state transitions
- **Result events**: Drive `completed`/`failed` terminal states

## Deliverables Created

| Deliverable | Location |
|-------------|----------|
| Full specification | `docs/spec/worker-dispatch-contract.md` |
| TypeScript types | `src/loop/dispatch-state.ts` |
| State machine logic | `src/loop/dispatch-state.ts` |

## Implementation Phases

1. **Phase 1**: Core state machine, checkpoint updates, dispatch enhancements
2. **Phase 2**: Telemetry integration, event schemas
3. **Phase 3**: State derivation, status updates, monitoring
4. **Phase 4**: Provider routing, CLI updates
5. **Phase 5**: Provider integrations (Windsurf, Copilot, Codex, Gemini)
6. **Phase 6**: Testing, documentation

## Provider Support Matrix

| Provider | Dispatch | Heartbeat | Approval | Status |
|----------|----------|-----------|----------|--------|
| Claude (Windsurf) | Agent subtask | Native progress API | Native UI | Designed |
| Copilot | LSP/Agent protocol | Extension heartbeat | VS Code approval | Planned |
| Codex | CLI spawn | File-based telemetry | Manual (external) | Designed |
| Gemini | CLI spawn | File-based telemetry | Manual (external) | Designed |

## Key Files

- Architecture spec: `docs/spec/worker-dispatch-contract.md`
- Implementation types: `src/loop/dispatch-state.ts`
- Integration point: `src/loop/checkpoint.ts` (for dispatch records)
- Integration point: `src/loop/status.ts` (for state display)
- Integration point: `src/loop/dispatch.ts` (for provider routing)
