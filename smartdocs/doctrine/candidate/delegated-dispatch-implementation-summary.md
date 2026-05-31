# Delegated Dispatch Foreman Seal Resolution - Implementation Summary

## Problem Resolved

The Foreman/Orchestrator seal prohibits implementation work, but delegated dispatch mode implied the orchestrator owned execution. This created a doctrine conflict.

## Solution

Redefined **delegated mode** to maintain strict separation:
- **Foreman**: Owns coordination (select, dispatch, monitor, escalate)
- **Worker**: Owns implementation (always - no exceptions)

## Files Changed

| File | Changes |
|------|---------|
| `src/loop/checkpoint.ts` | Added `WorkerAssignmentRecord` type; extended `ChildDispatchRecord` with `worker_assignment`; added validation |
| `src/loop/dispatch-state.ts` | Added delegated-mode telemetry events: `worker-assignment-attempted`, `worker-assigned`, `worker-assignment-failed`, `escalation-initiated`; added `DelegatedRuntimeState` type |
| `src/loop/status.ts` | Updated to show worker assignment info, Foreman seal compliance notices, and action guidance |
| `smartdocs/docs/doctrine/candidate/delegated-dispatch-foreman-seal.md` | Created doctrine specification |

## New Telemetry Events

```typescript
// Foreman attempting to assign worker
worker-assignment-attempted {
  assignment_type: "subagent" | "external-process" | "human-handoff"
}

// Worker successfully assigned
worker-assigned {
  assignment_type: string
  subagent_session_id?: string
  process_pid?: number
  handoff_token?: string
}

// Worker assignment failed
worker-assignment-failed {
  reason: "no-subagent-support" | "process-spawn-failed" | "provider-unavailable" | "timeout"
}

// Escalation to human operator
escalation-initiated {
  reason: string
  recommended_action: "manual-dispatch" | "provider-config" | "subagent-enable"
}
```

## Worker Assignment Record

```typescript
interface WorkerAssignmentRecord {
  assigned_at: string
  assignment_type: "subagent" | "external-process" | "human-handoff" | "pending-escalation"
  subagent_session_id?: string
  process_pid?: number
  handoff_token?: string
  escalation_reason?: string
}
```

## Status Output Examples

### With Worker Assignment (Subagent)

```
Dispatch Evidence:
  Child:            POL-203
  Mode:             delegated
  Runtime state:    delegated
  Visibility:       limited (orchestrator-owned)
  Assignment:       subagent
  Subagent session: gem-abc-123
  Assigned at:      2026-05-29T14:30:00.000Z
  Packet:           .polaris/clusters/POL-123/packets/POL-203-xxx.json
  Expected result:  .polaris/clusters/POL-123/results/POL-203-xxx.json
  Result present:   ✗ no
```

### Without Worker Assignment (Foreman Seal Warning)

```
Dispatch Evidence:
  Child:            POL-203
  Mode:             delegated
  Runtime state:    delegated
  Visibility:       limited (orchestrator-owned)
  Assignment:       (none yet)
  Packet:           .polaris/clusters/POL-123/packets/POL-203-xxx.json
  Expected result:  .polaris/clusters/POL-123/results/POL-203-xxx.json
  Result present:   ✗ no

  📋 Foreman Seal Compliance:
     Foreman coordinates; Foreman does NOT implement.
     A worker must be assigned or escalated.

     ⚠️  No worker assigned - implementation would violate seal
     Action: Assign worker or escalate to manual dispatch
```

### Escalated (Worker Unavailable)

```
Dispatch Evidence:
  Child:            POL-203
  Mode:             delegated
  Runtime state:    delegated
  Visibility:       limited (orchestrator-owned)
  Assignment:       pending-escalation
  Escalation:       No subagent support detected
  Assigned at:      2026-05-29T14:30:00.000Z
  Packet:           .polaris/clusters/POL-123/packets/POL-203-xxx.json
  Expected result:  .polaris/clusters/POL-123/results/POL-203-xxx.json
  Result present:   ✗ no
```

## Foreman Seal Compliance Verification

The status display now provides clear evidence of compliance:

| Check | Evidence Required |
|-------|-------------------|
| Worker assigned? | `worker_assignment` record present |
| Assignment type? | `subagent`, `external-process`, or `human-handoff` |
| Escalation documented? | `escalation-initiated` event or `pending-escalation` type |
| Implementation by Foreman? | Blocked by seal violation notice |

## Runtime State Derivation

| Mode | runtime_state undefined | Result |
|------|----------------------|--------|
| `delegated` | - | `"delegated"` (known state) |
| `direct-worker` | - | `"unknown"` (awaiting telemetry) |

## Next Steps (Future Implementation)

**Phase 2:**
- Implement worker assignment logic in Foreman
- Add subagent capability detection
- Implement escalation workflow

**Phase 3:**
- Add Foreman violation detection (automated seal enforcement)
- Block completion if no worker assignment evidence
- Automated escalation handling

## Testing

All 840 tests pass:
- 66 test files
- Includes new validation for `worker_assignment` fields
- Includes runtime state derivation test

## Validation

```bash
npm run build  # ✅ Compiles
npm test       # ✅ 840 tests pass
```
