# MCP Mutation Gating and Dry-Run Continuation Contract

**Issue:** POL-80  
**Type:** ANALYZE  
**Status:** Complete

---

## 1. Dry-Run Runtime Semantics

### What `loop continue --dry-run` means

A dry-run executes the continuation *decision logic* without executing any *continuation actions*. It answers "what would happen if I continued now?" with enough detail to seek approval.

### Stages that execute during dry-run

| Stage | Executes? | Notes |
|-------|-----------|-------|
| Load current runtime state | YES | Reads `.polaris/runs/{run_id}/current-state.json` |
| Validate state preconditions | YES | Ensures run is in a continuable state |
| Select next child | YES | **Temporary placeholder:** lowest open child by number. Future scheduling belongs to Polaris runtime policy/dependency logic, not this contract. |
| Determine worker type | YES | Derived from child task type (analyze/implement) |
| Preview eligible provider candidates | PREVIEW ONLY | Identifies currently eligible providers; not a reservation or authoritative selection. Actual routing decided at dispatch time. |
| Generate bootstrap packet content | PREVIEW ONLY | Content produced but not written to disk |
| Dispatch worker | NO | Hard forbidden |
| Write to `.polaris/runs/` | NO | Hard forbidden |
| Commit or push git changes | NO | Hard forbidden |
| Update Linear status | NO | Hard forbidden |
| Write artifacts | NO | Hard forbidden |

### Determinism requirement

Dry-run output **must be deterministic** for the same runtime state. Given identical `.polaris/runs/{run_id}/current-state.json` and Linear state, repeated dry-run calls return identical output. This enables the approval flow: an approver can re-run dry-run to verify nothing changed before confirming.

Non-determinism sources to suppress:
- Run IDs in bootstrap packet previews must use the existing `run_id`, not generate a new one
- Timestamps in previewed content must be marked as `<generated-at-dispatch>` placeholders
- Random nonces must not appear in dry-run output

---

## 2. Mutation Approval Contract

### Approval envelope structure

```json
{
  "run_id": "polaris-run-123",
  "expected_step_cursor": "06-decide-continuation",
  "expected_next_child": "POL-77",
  "state_fingerprint": "<sha256 of canonical state fields>",
  "approved_at": "2026-05-25T20:00:00Z",
  "expires_at": "2026-05-25T20:05:00Z"
}
```

### Validation rules

Polaris rejects a confirmation request if any of the following:

| Check | Rejection reason |
|-------|-----------------|
| `run_id` does not match current run | Stale approval — run identity mismatch |
| `expected_step_cursor` ≠ current `step_cursor` | Runtime advanced since approval was issued |
| `expected_next_child` ≠ computed next child | Child list changed since approval was issued |
| `state_fingerprint` ≠ computed fingerprint of current state | State mutated since approval was issued |
| `expires_at` < now | Approval TTL expired |
| `active_child` is non-null | Concurrent execution already in progress |

All six checks must pass. Rejection returns the specific failed check and current state values to allow the operator to re-run dry-run and re-approve.

### Approval TTL

Default: **5 minutes** from `approved_at`. This is long enough for a human to review the dry-run output and confirm, but short enough to prevent approvals that have gone stale due to racing sessions.

---

## 3. MCP Mutation Safety Model

### Authority boundaries

```
External operators (Claude Desktop, Alice, future Delegator)
  │
  │  bounded requests only — no shell, no filesystem, no git
  ▼
MCP tool interface (thin typed wrappers)
  │
  │  validated inputs + approval tokens
  ▼
Polaris runtime (orchestration + execution authority)
  │
  │  owns all state transitions
  ▼
.polaris/runs/ state   ←→   Linear   ←→   git
```

**Polaris runtime retains exclusive authority over:**
- `.polaris/runs/` state transitions
- Worker dispatch decisions
- Bootstrap packet generation and delivery
- git commit/push/PR operations
- Linear status mutations
- Artifact writes

**MCP operators are permitted to:**
- Query runtime state (read-only tools)
- Request dry-run previews (no mutation)
- Submit confirmed continuation requests (requires valid approval token)
- Receive structured execution results

**MCP operators are explicitly forbidden from:**
- Arbitrary shell command execution
- Direct filesystem mutation
- Direct git operations
- Bypassing approval gates
- Spawning workers directly
- Accessing `.polaris/` state files directly

### Tool classification

```
Tier 0 — Read-only (no approval required, always safe):
  polaris_status
  polaris_loop_status
  polaris_current_state

Tier 1 — Dry-run (no mutation, no approval required):
  polaris_loop_continue_dry_run

Tier 2 — Confirmed mutation (approval token required):
  polaris_loop_continue_confirmed       ← first mutating tool
  [future] polaris_loop_abort_confirmed
  [future] polaris_finalize_confirmed

Tier 3 — Privileged (internal Polaris runtime only, not MCP-exposed):
  worker dispatch
  bootstrap packet delivery
  git push
```

---

## 4. Runtime-State Verification Design

### State fingerprint

The state fingerprint is a SHA-256 hash of a canonical JSON representation of the mutable fields relevant to the next continuation:

```typescript
function computeStateFingerprint(state: CurrentState): string {
  const canonical = JSON.stringify({
    run_id: state.run_id,
    step_cursor: state.step_cursor,
    open_children: [...state.open_children].sort(),
    active_child: state.active_child,
    status: state.status,
  });
  return sha256(canonical);
}
```

Sorting `open_children` before hashing ensures order-independence.

### Generation and epoch invalidation

Any change to `runtime_generation` or `continuation_epoch` produces a different fingerprint and therefore invalidates all prior approval envelopes. These counters should be incremented whenever the runtime performs a structural state transition (e.g. recovering from a checkpoint, completing a continuation). This ensures stale approvals issued against an earlier generation cannot be replayed against a later one.

### Pre-mutation verification sequence

Before executing any confirmed continuation, Polaris runs this sequence:

1. Load `current-state.json` from disk (fresh read, never cached)
2. Validate schema (reject if malformed)
3. Assert `status === "running"` (reject if stopped/complete)
4. Assert `active_child === null` (reject if concurrent execution in progress)
5. Compute `state_fingerprint` of current state
6. Compare against `approval.state_fingerprint` (reject if mismatch)
7. Compare `approval.run_id` against `state.run_id` (reject if mismatch)
8. Compare `approval.expected_step_cursor` against `state.step_cursor` (reject if mismatch)
9. Compute next child via selection logic
10. Compare against `approval.expected_next_child` (reject if mismatch)
11. Assert `approval.expires_at > now` (reject if expired)

Only after all 11 checks pass does Polaris proceed to set `active_child` and begin execution.

### Atomic state acquisition

When beginning execution, Polaris must atomically:
1. Re-read current state (guard against TOCTOU between verification and mutation)
2. Set `active_child = next_child` and `step_cursor = "03-execute-child"`
3. Write to disk before dispatching worker

If the write fails, abort. Never dispatch without successfully writing `active_child`.

---

## 5. Continuation Replay and Recovery Recommendations

### Checkpoint architecture

```
.polaris/runs/{run_id}/
  current-state.json       ← live state
  checkpoints/
    {step_cursor}-{timestamp}.json   ← immutable snapshots
  audit.jsonl              ← append-only event log
```

A checkpoint is written **before** each irreversible action and **after** each successful action. Checkpoints are immutable once written.

### Recovery states and handling

| State | How to detect | Recovery action |
|-------|--------------|-----------------|
| `interrupted-before-dispatch` | `active_child` set, no dispatch record in audit log | Safe to retry: clear `active_child`, re-run selection, re-dispatch |
| `dispatched-awaiting-result` | Dispatch record in audit, no completion record | Check for worker result artifacts before re-dispatching; do not double-dispatch |
| `partial-commit` | Commit started but no commit hash in checkpoint | Run `git status` to determine actual commit state; write correct checkpoint |
| `linear-update-failed` | Commit succeeded but Linear status not Done | Retry Linear update idempotently (idempotent: update only if current status ≠ Done) |

### Idempotency requirements

Each step must be safe to re-execute:

- **Worker dispatch**: check dispatch record in audit log before dispatching; if already dispatched for this child in this run, skip re-dispatch and wait for result
- **git commit**: check if `HEAD` commit message already contains `[{child_id}]`; if so, do not re-commit
- **Linear status update**: read current status before updating; skip if already Done
- **Bootstrap packet write**: overwrite is safe (deterministic content); no guard needed

---

## 6. Audit and Event Logging Recommendations

### Audit event schema

```typescript
interface AuditEvent {
  timestamp: string;          // ISO-8601
  event_type: AuditEventType;
  run_id: string;
  step_cursor: string;
  operator: string;           // "claude-desktop" | "internal" | "alice" | ...
  operation: string;          // "dry_run" | "loop_continue" | "worker_dispatch" | ...
  child_id?: string;
  approval_fingerprint?: string;
  result: "ok" | "rejected" | "error" | "preview";
  rejection_reason?: string;
  error_detail?: string;
  metadata?: Record<string, unknown>;
}

type AuditEventType =
  | "dry_run_executed"
  | "mutation_requested"
  | "mutation_approved"
  | "mutation_rejected"
  | "worker_dispatched"
  | "worker_result_received"
  | "step_completed"
  | "checkpoint_written"
  | "run_stopped"
  | "run_completed"
  | "recovery_attempted";
```

### Logging rules

1. **All mutation requests** are logged, including rejected ones
2. **Dry-runs** are logged as `dry_run_executed` with `result: "preview"` (no side effects, but aids debugging)
3. **Audit log is append-only** — never modify or truncate existing entries
4. **Audit log is committed** with each checkpoint (ensures durable audit trail across sessions)
5. **Sensitive fields** (bootstrap packet content, approval tokens) are logged by hash only, not full value

### Audit log location

```
.polaris/runs/{run_id}/audit.jsonl
```

One JSON object per line. Written by Polaris runtime only. MCP tools cannot write directly to audit log.

---

## 7. First Safe Mutating MCP Tool Contract

### `polaris_loop_continue_dry_run`

**Type:** Tier 1 (no mutation, no approval required)

**Input:**
```typescript
interface DryRunInput {
  run_id: string;
  expected_step_cursor: string;
}
```

**Output (success):**
```typescript
interface DryRunOutput {
  ok: true;
  preview: {
    next_child: string;
    child_title: string;
    child_type: "analyze" | "implement";
    worker_type: "claude-code";
    provider: "claude";
    bootstrap_packet_preview: {
      issue_id: string;
      issue_title: string;
      branch: string;
      estimated_actions: string[];
    };
  };
  state_fingerprint: string;
  approval_template: {
    run_id: string;
    expected_step_cursor: string;
    expected_next_child: string;
    state_fingerprint: string;
    // caller fills: approved_at, expires_at
  };
}
```

**Output (failure):**
```typescript
interface DryRunRejection {
  ok: false;
  rejection: {
    reason: "run_not_found" | "step_cursor_mismatch" | "run_not_continuable" | "no_open_children";
    expected?: string;
    actual?: string;
  };
}
```

**Guarantees:**
- Never writes to disk
- Never dispatches workers
- Never modifies Linear
- Always returns the same output for the same runtime state (deterministic)
- Returns `approval_template` pre-filled with all fields except `approved_at`/`expires_at`, ready for the operator to sign and submit

### `polaris_loop_continue_confirmed` (future scope, contract defined here)

**Type:** Tier 2 (mutating, approval token required)

**Input:**
```typescript
interface ConfirmedContinuationInput {
  run_id: string;
  expected_step_cursor: string;
  expected_next_child: string;
  state_fingerprint: string;
  approved_at: string;       // ISO-8601
  expires_at: string;        // ISO-8601
}
```

**Output:** structured execution result or rejection with specific mismatch detail.

**Preconditions:** all 11 verification checks from §4 must pass.

---

## 8. Recommended Implementation Order

| Priority | Item | Why first |
|----------|------|-----------|
| 1 | State fingerprint utility | Needed by both dry-run and confirmed; low risk; pure function |
| 2 | Audit JSONL writer | Needed by all subsequent tools; append-only; trivially safe |
| 3 | `polaris_loop_continue_dry_run` | First MCP tool; no mutation risk; proves the contract |
| 4 | Pre-mutation verification suite (all 11 checks) | Gate for all future mutation tools |
| 5 | Approval token validation | Depends on verification suite; needed before any confirmed mutation |
| 6 | Checkpoint writer | Needed before confirmed continuation |
| 7 | `polaris_loop_continue_confirmed` | Builds on all prior items |
| 8 | Recovery procedures | Can be developed alongside confirmed continuation |
| 9 | Worker dispatch (within confirmed continuation) | Last — highest risk, requires all gates in place |

Do not implement worker dispatch until items 1–8 are proven in production. The dry-run tool provides immediate value (visibility into pending work) without any execution risk and can ship independently.

---

## 9. Delegator and Alice Compatibility Recommendations

### Provider-agnostic approval design

The approval contract is designed so Polaris does not need to know *who* approved — only that the approval token is structurally valid and matches current runtime state. This allows:

- Human confirmation via Claude Desktop
- Alice auto-approval based on policy rules
- Future Delegator issuing time-windowed or count-windowed approvals
- Batch-approved execution windows without redesigning the MCP contract

### Execution windows for bounded autonomous execution

Future Alice/Delegator can issue **execution windows** — approval tokens with extended bounds:

```typescript
interface ExecutionWindow {
  run_id: string;
  max_continuations: number;    // approve next N children
  valid_from: string;
  valid_until: string;
  allowed_child_types: Array<"analyze" | "implement">;
  state_fingerprint_at_issue: string;
}
```

Polaris validates the window on each continuation: decrement `max_continuations`, re-verify fingerprint (or accept fingerprint drift within window if policy permits), and refuse if any bound is exceeded.

### Alice compatibility principles

1. **Dry-run contract is stable**: Alice implements against `polaris_loop_continue_dry_run` without version coupling. The `approval_template` in the response gives Alice exactly the fields needed for confirmation.
2. **Fingerprint is deterministic**: Alice can re-run dry-run to get the same fingerprint before auto-approving.
3. **Idempotent confirmations**: re-submitting an already-executed approval returns `{ ok: true, status: "already_executed" }` rather than an error. This allows Alice to safely retry on network failure.
4. **Policy hooks**: future Polaris versions should expose a `before_mutation` hook (not MCP-facing) that Alice/Delegator can register — allowing policy evaluation without changing the MCP contract.

### What must NOT change when Delegator/Alice arrives

- The `dry_run` tool shape
- The approval envelope field names
- The fingerprint algorithm
- The rejection reason vocabulary

These form a stable protocol surface. Additive changes (new optional fields, new rejection reasons) are permitted; breaking changes require a versioned tool name.

---

## 10. Follow-Up Implementation Issue Breakdown

| Issue | Title | Depends on | Deliverable |
|-------|-------|-----------|-------------|
| POL-81 | Implement state fingerprint and verification utilities | — | `src/loop/verify.ts`: `computeStateFingerprint`, `verifyApprovalEnvelope` |
| POL-82 | Implement audit JSONL event logger | POL-81 | `src/loop/audit.ts`: `appendAuditEvent`, event schema |
| POL-83 | Implement `polaris_loop_continue_dry_run` MCP tool | POL-81, POL-82 | `src/mcp/loop-dry-run.ts` + MCP registration |
| POL-84 | Implement checkpoint writer and recovery procedures | POL-81, POL-82 | `src/loop/checkpoint.ts`: `writeCheckpoint`, `recoverFromCheckpoint` |
| POL-85 | Implement `polaris_loop_continue_confirmed` MCP tool | POL-81–84 | `src/mcp/loop-continue.ts` + MCP registration |
| POL-86 | Implement execution window support for Alice/Delegator | POL-85 | `src/loop/execution-window.ts`: window validation and decrement |
| POL-87 | End-to-end integration test: dry-run → confirm → execution | POL-85 | `test/loop/continuation-flow.test.ts` |

**Recommended cluster boundary:** POL-81 through POL-84 form a safe first cluster (infrastructure only, no live mutation). POL-85 through POL-87 form the second cluster (live mutation, requires first cluster complete and verified in production).

---

## Summary

The safe first mutating path for Polaris MCP is:

```
Claude Desktop
  → polaris_loop_continue_dry_run    (Tier 1: preview, no mutation)
  → review approval_template output
  → polaris_loop_continue_confirmed  (Tier 2: requires valid approval token)
  → Polaris runtime verifies 11 preconditions
  → Polaris runtime dispatches worker
  → durable execution state + audit trail
```

Polaris remains the execution authority at every step. External operators are bounded requesters only. The approval contract is provider-agnostic and Alice/Delegator-compatible without future redesign.
