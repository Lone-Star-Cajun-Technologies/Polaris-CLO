# MCP Confirmed-Dispatch Architecture

**Status:** Authoritative architecture spec  
**Issue:** POL-89  
**Parent:** POL-88 — Analyze bridge: MCP confirmed continuation into execution adapter dispatch

---

## Overview

The MCP `polaris_loop_continue_confirmed` tool call currently stops at approval validation, checkpoint writing, and `continuation_epoch` increment. It intentionally does NOT dispatch workers. This document specifies the complete architecture for bridging the `confirmed` state to execution adapter dispatch, satisfying the constraint that MCP is a bounded control interface — not an orchestration authority.

The gap exists in `src/mcp/tools/loop-continue.ts` at line 163–184: after `writeState` mutates `continuation_epoch`, the function returns `{ ok: true, next_child, message: "Continuation approved. Worker dispatch is not yet implemented." }`.

This spec defines all architectural decisions needed to close that gap safely.

---

## 1. MCP-to-Runtime Dispatch Architecture

### Module ownership

The `confirmed → dispatch` transition must NOT be owned by `src/mcp/tools/loop-continue.ts`. MCP is a thin translation layer. The dispatch logic belongs in a new runtime service:

```
src/runtime/continuation/confirmed.ts
```

This module is the single authority for all confirmed-continuation dispatch, regardless of whether the trigger came from MCP or CLI.

### Responsibility boundary

| Layer | Module | Responsibility |
|---|---|---|
| MCP transport | `src/mcp/tools/loop-continue.ts` | Parse/validate MCP input; call runtime service; return MCP response shape |
| Runtime service | `src/runtime/continuation/confirmed.ts` | All dispatch logic: lease, checkpoint, adapter, audit |
| Adapter | `src/loop/execution-adapter.ts` + adapter impl | Execution mode selection; `BootstrapPacket` construction; worker dispatch |
| State | `src/runtime/state.ts` | `loadState` / `writeState` |
| Checkpoint | `src/runtime/checkpoint.ts` | `writeCheckpoint` |
| Audit | `src/runtime/audit/logger.ts` | `appendAuditEvent` |

### New service signature (confirmed.ts)

```typescript
export interface ConfirmedContinuationRequest {
  artifact_dir: string;
  envelope: ContinuationApprovalEnvelope;
  adapterOverride?: ExecutionAdapterMode;
  executionWindow?: ExecutionWindow;
}

export interface ConfirmedContinuationResult {
  ok: true;
  child_id: string;
  compact_return: CompactReturn;
}
| {
  ok: false;
  rejection: { check: string; reason: string; expected?: string; actual?: string };
}

export async function dispatchConfirmedContinuation(
  request: ConfirmedContinuationRequest
): Promise<ConfirmedContinuationResult>
```

### Updated MCP handler

After introducing `confirmed.ts`, `handleLoopContinueConfirmed` in `loop-continue.ts` becomes:

```typescript
// After envelope validation passes, replace the current writeState block with:
const dispatchResult = await dispatchConfirmedContinuation({
  artifact_dir,
  envelope,
});
if (!dispatchResult.ok) {
  return { ok: false, rejection: dispatchResult.rejection };
}
return {
  ok: true,
  child_id: dispatchResult.child_id,
  compact_return: dispatchResult.compact_return,
};
```

The in-memory `pendingConfirmations` lock in `loop-continue.ts` remains. It guards the gap between concurrent MCP calls entering `handleLoopContinueConfirmed` before either writes `active_child` to disk. The durable `active_child` lease in `confirmed.ts` is the second, disk-backed guard.

---

## 2. Shared CLI/MCP Continuation Service Boundaries

### The two continuation entry points

| Entry point | Module | State machine |
|---|---|---|
| CLI `polaris continue` | `src/loop/continue.ts` (`runLoopContinue`) | Synchronous; reads state, writes `active_child = ""`, builds bootstrap packet, calls adapter |
| MCP `polaris_loop_continue_confirmed` | `src/mcp/tools/loop-continue.ts` (`handleLoopContinueConfirmed`) | Async; validates envelope; calls `confirmed.ts` |

### Shared runtime service

Both entry points converge on a shared execution primitive. CLI wraps the legacy `buildBootstrapPacket` + `writeBootstrapPacket` path. MCP uses `confirmed.ts` which calls the same `selectExecutionAdapter` → adapter dispatch sequence.

Critically, they must NOT share mutable state. Each invocation:

1. Takes a fresh `loadState` read as its authority — never a cached `CurrentState`.
2. Sets and clears `active_child` independently.
3. Appends its own audit trail.

The CLI path (`runLoopContinue`) does NOT go through `confirmed.ts`. It already has its own state machine with `writeStateAtomic` via the `loop/checkpoint.ts` read/write helpers. Sharing is at the adapter-selection layer, not at the state-management layer, to avoid coupling two different state machines.

### No diverging state machines

To prevent state divergence:

- Both paths must set `active_child` to a non-empty child ID before dispatch, and clear it to `""` after result receipt.
- Both paths must write a pre-dispatch checkpoint before mutating `active_child`.
- The `continuation_epoch` increment that already exists in `handleLoopContinueConfirmed` (line 165) must move into `confirmed.ts`, so it is always paired with the `active_child` write in a single `writeState` call.

---

## 3. Durable Worker Lease Model

### active_child as a durable lease

`CurrentState.active_child` (defined in `src/types/runtime-state.ts` as `string | null`) is the durable dispatch lease. The field is the serialized form of a "slot is occupied" invariant.

**Set:** Immediately before worker dispatch, `confirmed.ts` writes:

```typescript
await writeState(artifact_dir, {
  ...state,
  active_child: nextChild,           // non-empty: slot occupied
  continuation_epoch: (state.continuation_epoch ?? 0) + 1,
});
```

Both the `active_child` assignment and the `continuation_epoch` increment happen in a single `writeState` call. This is the dispatch lease acquisition.

**Cleared:** After the worker returns a `CompactReturn` with `state_updated: true`, the worker itself writes `active_child: ""` back to disk (see `executeOneChild` in `src/loop/worker.ts`, lines 228–241). For the MCP path, if the worker is an `agent-subtask` that updates state directly, the runtime service must verify `state_updated: true` in the `CompactReturn` before returning `ok: true`.

If the worker returns `state_updated: false`, `confirmed.ts` must clear `active_child` defensively and record a `recovery_attempted` audit event.

**Preventing cross-process duplicate dispatch:**

The envelope validation in `validateEnvelope` (in `src/runtime/verification/envelope.ts`) checks `active_child`:

```typescript
const activeChild = state.active_child ?? "";
if (activeChild !== "") {
  return { ok: false, failure: { check: "active_child", reason: "concurrent_execution", actual: activeChild } };
}
```

This check uses the fresh-disk-read state from `handleLoopContinueConfirmed` (line 87: `await loadState(artifact_dir)`). Any process that reads `active_child !== ""` from disk will fail this check and reject before dispatch. The in-memory `pendingConfirmations` set handles the narrower race where two Node.js async operations read state before either writes it.

---

## 4. Exactly-One-Child Dispatch Contract

### Enforcement layers

The exactly-one-child invariant is enforced at three independent layers:

1. **`ExecutionAdapterContract.dispatch_contract`** (defined in `src/loop/execution-adapter.ts`, lines 57–64): The `dispatch_contract` field carries `{ one_child_per_worker: true }` as a protocol-level declaration. Any adapter implementation must honour this.

2. **`BootstrapPacket.active_child`** (defined in `src/loop/adapters/types.ts`): The packet delivered to the worker contains exactly one `active_child`. The worker (`runWorker` in `src/loop/worker.ts`) is documented to execute exactly one child and call `process.exit()` — it cannot loop.

3. **`selectNextChild` binding**: `confirmed.ts` calls `selectNextChild(state)` once (via `validateEnvelope`'s final check) and binds the result to a single `nextChild`. The `nextChild` value used to set `active_child` must come from the same `validateEnvelope` result — it must not be re-evaluated after state mutation. This prevents a TOCTOU window where a different child becomes "next" between validation and dispatch.

### Dispatch boundary assertion

Before calling the adapter, `confirmed.ts` must assert:

```typescript
if (nextChild === null || nextChild === "") {
  throw new Error("dispatch_invariant_violated: nextChild must be non-empty at dispatch boundary");
}
```

This assertion is never expected to fire (it would mean `validateEnvelope` returned `ok: true` with a null child), but it makes the contract explicit and prevents silent mis-dispatch.

---

## 5. Checkpoint / Audit Sequence

The ordered sequence from `confirmed` to `dispatch` to `result`:

### Pre-dispatch (in `confirmed.ts`)

1. **`mutation_requested` audit event** (already written in `handleLoopContinueConfirmed` after validation passes — must move into `confirmed.ts`)
2. **`checkpoint_written` audit event** via `writeCheckpoint(artifact_dir, state.step_cursor)` — records the pre-dispatch state snapshot in `.taskchain_artifacts/{artifact_dir}/checkpoints/`
3. **`active_child` lease write** via `writeState(artifact_dir, { ...state, active_child: nextChild, continuation_epoch: ... })`
4. **`mutation_approved` audit event** — records `{ next_child: nextChild }` in metadata (currently written in `handleLoopContinueConfirmed` after `writeState` — must move into `confirmed.ts` and fire after the lease write)

### Dispatch

5. **`worker_dispatched` audit event** — written immediately before the adapter `dispatch()` call. Fields: `run_id`, `step_cursor`, `child_id: nextChild`, `operator: "mcp"`, `operation: "confirmed_dispatch"`, `result: "ok"`, `metadata: { adapter_mode }`.

### Post-dispatch / result

6. **Adapter returns `DispatchResult`** — `confirmed.ts` receives the compact return from the worker.
7. **`worker_result_received` audit event** — written after the adapter returns. Fields: `child_id: nextChild`, `result: "ok" | "error"`, `metadata: { exit_code, status }`.
8. **Final `writeState`** — if `CompactReturn.state_updated` is false, `confirmed.ts` writes the cleared `active_child: ""` plus updated `step_cursor`, `completed_children`, `open_children`.

### Audit event types already defined

`src/types/runtime-state.ts` defines `AuditEventType` which includes `"worker_dispatched"` and `"worker_result_received"`. No new event types need to be added.

---

## 6. Recovery Semantics

### Recovery state classification

`src/runtime/checkpoint.ts` (lines 8–22) documents the four recovery state classifications:

| State | Condition | Resolution |
|---|---|---|
| `interrupted-before-dispatch` | `active_child` is set; no `worker_dispatched` audit event for this `run_id + step_cursor` | Clear `active_child`; retry dispatch from the top of `confirmed.ts` flow |
| `dispatched-awaiting-result` | `worker_dispatched` event exists; no `worker_result_received` event follows | Query the provider for worker result; do NOT re-dispatch |
| `partial-commit` | `step_completed` event exists; no commit hash in checkpoint | Check `git log` for the expected commit |
| `linear-update-failed` | Commit hash present; no Linear Done event | Re-read Linear status; retry idempotently |

### Detection logic (to be implemented in confirmed.ts)

On entry to `dispatchConfirmedContinuation`, before acquiring the lease, the service should detect existing interrupted recovery states:

```typescript
const auditLog = await readAuditLog(artifact_dir);
const lastDispatch = findLastEvent(auditLog, "worker_dispatched", state.run_id, state.step_cursor);
const lastResult  = findLastEvent(auditLog, "worker_result_received", state.run_id, state.step_cursor);

if (lastDispatch && !lastResult) {
  // Recovery state: dispatched-awaiting-result
  // Do NOT re-dispatch; return a recovery-mode result
  return { ok: false, rejection: { check: "recovery", reason: "dispatched-awaiting-result" } };
}
if (state.active_child && !lastDispatch) {
  // Recovery state: interrupted-before-dispatch
  // Clear active_child, then proceed with fresh dispatch
  await writeState(artifact_dir, { ...state, active_child: null });
  await appendAuditEvent(artifact_dir, { event_type: "recovery_attempted", ... });
  // Continue with dispatch flow using refreshed state
}
```

### Idempotency requirements (from checkpoint.ts)

Worker dispatch: Check the audit log for a prior `worker_dispatched` event with the same `run_id + step_cursor` before dispatching. Do not dispatch a second time if one exists.

---

## 7. Adapter Safety Constraints

### ExecutionAdapterMode values and MCP safety

| Mode | `autoDispatch` | `providerCoupling` | MCP-triggered dispatch |
|---|---|---|---|
| `agent-subtask` | `true` | `native-same-agent` | **Safe; expected for first slice** |
| `cross-agent` | `true` | `explicit-cross-agent` | Safe with explicit config; requires `crossAgentConfigured: true` |
| `terminal-cli` | `false` | `shell-process` | Requires human-in-the-loop for spawn; NOT auto-dispatchable |
| `ci` | `false` | `remote-worker` | NOT auto-dispatchable without CI integration |
| `ssh` | `false` | `remote-worker` | NOT auto-dispatchable |
| `remote-worker` | `false` | `remote-worker` | NOT auto-dispatchable |

`selectExecutionAdapter` in `src/loop/execution-adapter.ts` (line 129) returns an `AdapterSelection` with an `autoDispatch: boolean` field. `confirmed.ts` must check `selection.autoDispatch === true` before proceeding with automatic dispatch. If `autoDispatch` is false, the service must return a structured result indicating that the operator must manually trigger the worker, rather than attempting to auto-dispatch.

### Adapter selection flow through runtime service

`confirmed.ts` calls `selectExecutionAdapter` with:

```typescript
const selection = selectExecutionAdapter({
  explicitAdapter: request.adapterOverride,
  configuredAdapter: configuredAdapterFromArtifactDir(artifact_dir),
  insideAgentSession: true,          // MCP is always called from inside an agent session
  nativeSubtaskAvailable: true,      // assume available; adapter impl will fail if not
  crossAgentConfigured: false,       // conservative default; override via config
  tokenBudgetLow: false,
});

if (!selection.autoDispatch) {
  return {
    ok: false,
    rejection: {
      check: "adapter_mode",
      reason: "manual_dispatch_required",
      detail: `Adapter "${selection.mode}" requires manual operator dispatch`,
    },
  };
}
```

The `buildExecutionAdapterContract` function (line 190 in `execution-adapter.ts`) is then used to build the full contract including `compact_bootstrap_state`. The `BootstrapPacket` passed to the adapter's `dispatch()` method must conform to `src/loop/adapters/types.ts`.

---

## 8. Execution-Window Interaction

### Where validateWindow is called

`validateWindow` (in `src/runtime/execution-window.ts`, line 75) takes `(state: CurrentState, window: ExecutionWindow, currentFingerprint: string)` and returns `WindowValidationResult`. It is a pure function with no side effects.

In `confirmed.ts`, execution-window validation is an optional pre-dispatch check:

```typescript
if (request.executionWindow) {
  const fingerprint = computeStateFingerprint({ state, approvalNonce: request.executionWindow.run_id });
  const windowResult = validateWindow(state, request.executionWindow, fingerprint);
  if (!windowResult.ok) {
    return { ok: false, rejection: { check: "execution_window", reason: windowResult.reason } };
  }
}
```

### When the window is decremented relative to dispatch

Window decrement ordering is critical. The window must be decremented **after** the `active_child` lease is written to disk but **before** the adapter `dispatch()` call returns. The sequence:

1. `writeState` with `active_child = nextChild` (lease acquired)
2. `decrementWindow(window)` — returns a new window (pure, no side effects)
3. Persist the decremented window — write back to state or a separate window store
4. Call `adapter.dispatch(packet, options)` — worker begins

This ordering ensures that a crash after step 1 but before step 4 is detected as `interrupted-before-dispatch`. A crash after step 4 but before `worker_result_received` is `dispatched-awaiting-result`.

`decrementWindow` (line 139 in `execution-window.ts`) is explicitly documented: "The caller is responsible for persisting the returned window exactly once to ensure idempotency at the protocol level."

### ExecutionWindow in CurrentState

`CurrentState` (in `src/types/runtime-state.ts`) does not currently have an `execution_window` field. One of two options is valid:

- **Option A (recommended for first slice):** Pass `executionWindow` as a parameter to `dispatchConfirmedContinuation` only; store the decremented window in a side-file or omit window management from the first slice entirely.
- **Option B (complete implementation):** Add `execution_window?: ExecutionWindow` to `CurrentState` and persist the decremented window as part of the post-lease `writeState` call.

The first-slice recommendation (section 9) uses Option A.

---

## 9. First Implementation Slice Recommendation

### Recommendation: dispatch-only, no wait-for-result

The first implementation slice should be **dispatch-only**, meaning:

1. `confirmed.ts` acquires the `active_child` lease.
2. `confirmed.ts` constructs the `BootstrapPacket` and calls the adapter's `dispatch()` method.
3. For `agent-subtask` mode, dispatch is synchronous within the agent session — `confirmed.ts` awaits the `CompactReturn`.
4. For any other mode where `autoDispatch === false`, the service returns a structured "manual dispatch required" result.

No execute-and-wait polling loop is needed in the first slice. The `agent-subtask` adapter's `dispatch()` is inherently synchronous.

### File layout

**New file:**

```
src/runtime/continuation/confirmed.ts
```

Exports:
- `ConfirmedContinuationRequest` interface
- `ConfirmedContinuationResult` type
- `dispatchConfirmedContinuation(request: ConfirmedContinuationRequest): Promise<ConfirmedContinuationResult>`

**Modified file:**

```
src/mcp/tools/loop-continue.ts
```

Changes:
- Import `dispatchConfirmedContinuation` from `../../runtime/continuation/confirmed.js`
- Replace the `writeState`/`appendAuditEvent(mutation_approved)` block (lines 163–184) with a call to `dispatchConfirmedContinuation`
- Move `continuation_epoch` increment into `confirmed.ts` (it must stay paired with the `active_child` write)

**No other src/ files should be modified in the first slice.**

### Exact function layout for confirmed.ts

```typescript
// src/runtime/continuation/confirmed.ts

import type { ContinuationApprovalEnvelope } from "../verification/envelope.js";
import type { ExecutionWindow }              from "../execution-window.js";
import type { ExecutionAdapterMode }         from "../../loop/execution-adapter.js";
import type { CompactReturn }                from "../../loop/compact-return.js";
import { validateEnvelope }                  from "../verification/envelope.js";
import { validateWindow, decrementWindow }   from "../execution-window.js";
import { selectExecutionAdapter }            from "../../loop/execution-adapter.js";
import { loadState, writeState }             from "../state.js";
import { writeCheckpoint }                   from "../checkpoint.js";
import { appendAuditEvent }                  from "../audit/logger.js";

export interface ConfirmedContinuationRequest { ... }
export type ConfirmedContinuationResult = { ok: true; child_id: string; compact_return: CompactReturn }
                                        | { ok: false; rejection: { check: string; reason: string } };

export async function dispatchConfirmedContinuation(
  request: ConfirmedContinuationRequest
): Promise<ConfirmedContinuationResult> {
  // 1. Fresh state read
  // 2. Re-validate envelope (defensive; MCP handler already validated once)
  // 3. Execution window check (if provided)
  // 4. Recovery state detection
  // 5. Pre-dispatch checkpoint
  // 6. Acquire active_child lease (writeState with active_child + continuation_epoch)
  // 7. mutation_approved audit event
  // 8. Adapter selection + autoDispatch check
  // 9. worker_dispatched audit event
  // 10. adapter.dispatch(packet, options)
  // 11. worker_result_received audit event
  // 12. Defensive active_child clear if worker did not update state
  // 13. Return CompactReturn
}
```

---

## 10. Follow-Up Implementation Cluster Breakdown

The following implementation issues should be created by POL-90. They are listed in dependency order.

### Issue A — `confirmed.ts` skeleton + lease write (no adapter call)

**Scope:** Create `src/runtime/continuation/confirmed.ts` with the full function signature and all steps up through and including `active_child` lease write. The adapter call is stubbed. Update `loop-continue.ts` to call the new service. All existing tests must continue to pass.

**Depends on:** nothing (first issue in cluster).

### Issue B — Adapter selection + `autoDispatch` gating

**Scope:** Implement adapter selection via `selectExecutionAdapter` inside `confirmed.ts`. Add `autoDispatch` guard. Add `adapterOverride` support. Write unit tests for adapter gating (safe vs unsafe modes).

**Depends on:** Issue A.

### Issue C — `agent-subtask` dispatch + `CompactReturn` handling

**Scope:** Wire `agent-subtask` adapter's `dispatch()` into `confirmed.ts`. Parse `CompactReturn` from worker stdout. Handle `state_updated: false` defensive clear. Add integration test: confirmed → dispatch → compact return round-trip.

**Depends on:** Issues A and B.

### Issue D — Execution window validation in confirmed.ts

**Scope:** Accept `executionWindow?: ExecutionWindow` in `ConfirmedContinuationRequest`. Call `validateWindow` and `decrementWindow`. Persist decremented window. Add `allowed_child_types` check (the TODO in `execution-window.ts` line 127). Unit tests for window validation.

**Depends on:** Issue A (can be developed in parallel with B and C).

### Issue E — Recovery state detection

**Scope:** Implement `interrupted-before-dispatch` and `dispatched-awaiting-result` detection logic in `confirmed.ts`. Add audit log reader utility. Integration tests for both recovery paths.

**Depends on:** Issues A and C.

### Issue F — MCP response shape update + end-to-end test

**Scope:** Update `handleLoopContinueConfirmed` return shape to include `compact_return`. Add end-to-end test covering the full MCP confirmed → dispatch → result path with `agent-subtask` adapter. Update MCP tool documentation.

**Depends on:** Issues A, B, C.

---

## Appendix: Key Type References

| Type | Source file | Purpose |
|---|---|---|
| `CurrentState` | `src/types/runtime-state.ts` | Runtime state shape; `active_child` field |
| `AuditEventType` | `src/types/runtime-state.ts` | Audit event type union; `worker_dispatched`, `worker_result_received` |
| `ContinuationApprovalEnvelope` | `src/runtime/verification/envelope.ts` | Approval token validated by `validateEnvelope` |
| `EnvelopeValidationResult` | `src/runtime/verification/envelope.ts` | `{ ok: true; next_child: string }` on success |
| `RecoveryState` | `src/runtime/checkpoint.ts` | `"interrupted-before-dispatch" \| "dispatched-awaiting-result" \| ...` |
| `CheckpointRecord` | `src/runtime/checkpoint.ts` | Snapshot written by `writeCheckpoint` |
| `ExecutionAdapterMode` | `src/loop/execution-adapter.ts` | `"agent-subtask" \| "terminal-cli" \| ...` |
| `AdapterSelection` | `src/loop/execution-adapter.ts` | Includes `autoDispatch: boolean` |
| `ExecutionAdapterContract` | `src/loop/execution-adapter.ts` | Full contract with `dispatch_contract` |
| `BootstrapPacket` | `src/loop/adapters/types.ts` | Packet delivered to worker; contains `active_child` |
| `CompactReturn` | `src/loop/compact-return.ts` | Worker stdout result: `status`, `state_updated`, etc. |
| `ExecutionWindow` | `src/runtime/execution-window.ts` | Bounded authorisation; validated by `validateWindow` |
| `WindowValidationResult` | `src/runtime/execution-window.ts` | `{ ok: true }` or `{ ok: false; reason; detail? }` |
| `DryRunPreview` | `src/runtime/continuation/dry-run.ts` | Preview shape from `executeDryRun` |
