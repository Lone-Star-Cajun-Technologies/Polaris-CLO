---
kind: spec
status: active
source: closeout-librarian-runtime
created: 2026-06-03
depends_on:
  - foreman-worker-architecture.md
  - foreman-quiet-mode-spec.md
  - worker-heartbeat-spec.md
  - closeout-librarian-spec.md
source_paths:
  - src/loop/dispatch-boundary.ts
  - src/loop/continue.ts
  - src/loop/dispatch.ts
related:
  - pol-288-foreman-worker-drift-postmortem.md
---

# Runtime Enforcement Strategy

**Status:** Authoritative spec
**Created:** 2026-06-03
**Evidence:** polaris-run-pol-283-2026-06-02-002 (POL-288 postmortem)

---

## 1. Design Principle

Governance boundaries must be enforced by the runtime, not solely by role instructions.

Instructions degrade over time. Runtime enforcement is durable.

For every authority boundary, ask: "If an agent ignores this instruction, what happens?"
The answer should be "the runtime hard-fails" — not "nothing happens."

The POL-288 postmortem demonstrated that:
- Instruction-level prohibitions alone are insufficient (F2: scope guard ignored)
- Hard failures already work well (dispatch boundary enforcement: `dispatch-boundary.ts`)
- The pattern should be extended to new boundary surfaces

---

## 2. Current Hard Enforcements

These boundaries are already runtime-enforced:

| Boundary | Enforcement | File |
|---|---|---|
| No `loop continue` without prior dispatch | `exit(1)` + `dispatch-required` telemetry | `src/loop/dispatch-boundary.ts` |
| No `loop dispatch` with `active_child` already set | `exit(1)` + `invalid-inline-attempt` telemetry | `src/loop/dispatch-boundary.ts` |
| No inline child completion without dispatch record | `exit(1)` + `illegal-state-transition` telemetry | `src/loop/dispatch-boundary.ts` |
| State file path validation on finalize | `process.exit(1)` | `src/finalize/index.ts` |
| Branch/cluster ID mismatch on finalize | `process.exit(1)` | `src/finalize/index.ts` |
| Delivery integrity gate | `process.exit(1)` | `src/finalize/delivery-integrity.ts` |

---

## 3. New Enforcement Requirements

### 3.1 Librarian Gate on Finalize

**Gap:** Finalize can be called before the Closeout Librarian completes.
**Enforcement:** Before PR creation (step 08-create-pr.ts), finalize reads the Librarian
result from the cluster state. If no Librarian result is present or status is not
`"success"/"partial"`, finalize exits with a clear error.

```typescript
// src/finalize/steps/08-create-pr.ts (future)
const librarianResult = readLibrarianResult(state.librarian_result_path);
if (!librarianResult || !["success", "partial"].includes(librarianResult.status)) {
  process.stderr.write("finalize aborted: Closeout Librarian has not completed...\n");
  process.exit(1);
}
```

**Implementation target:** `src/finalize/steps/08-create-pr.ts` or a new pre-PR gate step.
**Classification:** Required during implementation.

### 3.2 Worker Scope Fidelity Check

**Gap:** Workers can commit files outside `allowed_scope`. The Foreman discovers this
after the fact by reading worker output.
**Enforcement:** In `continue.ts`, after receiving the CompactReturn, run a git diff
analysis to detect files committed outside `allowed_scope`. Emit `worker-scope-fidelity`
telemetry event. If out-of-scope files detected, escalate before advancing the queue.

```typescript
// src/loop/continue.ts (future)
const fidelityCheck = checkWorkerScopeFidelity(repoRoot, completedChildId, allowedScope, commitSha);
if (fidelityCheck.out_of_scope.length > 0) {
  emitTelemetry("worker-scope-fidelity", { out_of_scope_files: fidelityCheck.out_of_scope });
  // Escalate rather than advance queue
}
```

**Implementation target:** `src/loop/continue.ts`
**Classification:** Required during implementation.

### 3.3 CLI-Owned Worker State Writes

**Gap:** Workers can write to `current-state.json` directly.
**Enforcement:** Add `npm run polaris -- worker complete <result-file>` CLI command.
Workers call this CLI command (not file writes). The CLI validates the result file,
updates state atomically, and appends telemetry.

Workers writing directly to `current-state.json` would be caught by scope validation.

**Implementation target:** `src/cli/worker.ts` (extend existing worker CLI)
**Classification:** Required during implementation.

### 3.4 Foreman Live Repair Detection

**Gap:** Foreman can patch state files directly without using CLI commands.
**Enforcement:** Add `state-mutation-detected` telemetry event when files in
`prohibited_write_paths` are written outside of CLI-sanctioned write paths.
This requires CLI ownership of state files.

Interim instruction-level: `.polaris/roles/foreman.md` explicitly prohibits direct
state file edits and requires using `polaris loop abort` before any repair.

**Implementation target:** `src/runtime/state.ts` (file write monitoring)
**Classification:** Future enhancement.

### 3.5 Scope Violation as Decision Point

**Gap:** Scope violations (worker committing outside allowed scope) are currently fixed
by the Foreman automatically, not treated as decision points.
**Enforcement:** When `worker-scope-fidelity` detects a violation, the Foreman halts and
presents options to the operator rather than repairing automatically.

Options presented:
1. Reject result (re-dispatch replacement worker)
2. Accept with exception (record violation, continue)
3. Create triage note and halt
4. Pause for manual review

**Classification:** Required during implementation.

---

## 4. Enforcement Tiers

### Tier 1: Instruction + Role File (Implemented)

| Boundary | Mechanism | Status |
|---|---|---|
| Foreman quiet mode | `.polaris/roles/foreman.md` | Implemented |
| Worker output rules | `.polaris/roles/worker.md` | Implemented |
| Worker commit scope verification | `.polaris/roles/worker.md` | Implemented |
| Foreman state repair prohibition | `.polaris/roles/foreman.md` | Implemented |
| Librarian authority boundaries | `.polaris/roles/closeout-librarian.md` | Implemented |
| CHECKPOINT gate wording | `.polaris/skills/polaris-run/chain.md` | Implemented |

### Tier 2: Runtime Enforcement (Required During Implementation)

| Boundary | Mechanism | Target File |
|---|---|---|
| Librarian gate on finalize | `exit(1)` before PR if no Librarian result | `src/finalize/steps/08-create-pr.ts` |
| Worker scope fidelity | `worker-scope-fidelity` telemetry + escalation gate | `src/loop/continue.ts` |
| CLI-owned state writes | `polaris worker complete` CLI command | `src/cli/worker.ts` |
| Librarian dispatch record | Foreman records librarian dispatch in cluster state | `src/loop/dispatch.ts` or new module |
| `librarian packet` CLI command | `npm run polaris -- librarian packet <id>` | `src/cli/` |

### Tier 3: Deep Enforcement (Future Enhancement)

| Boundary | Mechanism | Target |
|---|---|---|
| CLI-owned git commits | `polaris worker commit` validates scope before commit | `src/cli/worker.ts` |
| Adapter output filtering | CompactReturn-only extraction in terminal-cli | `src/loop/adapters/terminal-cli.ts` |
| Foreman context isolation | Worker session context discarded after CompactReturn | Adapter level |
| Filesystem sandbox | OS-level write restriction to allowed_scope | Infrastructure |
| Linear mutation ownership | `polaris worker done` validates evidence before Linear update | `src/cli/worker.ts` |

---

## 5. Decision Point Model

Scope violations, heartbeat expiration, and Librarian failures are DECISION POINTS,
not automatic repairs.

When a decision point is reached:
1. The Foreman halts the current operation.
2. The Foreman describes the issue (1–3 sentences, factual).
3. The Foreman presents options (numbered list).
4. The Foreman asks the operator to choose.
5. The Foreman waits.

**What is NOT a decision point** (these are hard failures, not decisions):
- Dispatch boundary violation (already enforced by `dispatch-boundary.ts`)
- Delivery integrity check failure
- Bootstrap seal failure

For hard failures: exit immediately with a clear error. No operator decision needed.

---

## 6. Rationale (POL-288 Evidence)

The enforcement failures documented in POL-288:

| Failure | Root Cause | Enforcement Target |
|---|---|---|
| F1: 21.7M cached tokens (Foreman observed worker) | `stdio: "inherit"` in adapter | Adapter output filtering (Tier 3) |
| F2: Worker committed `current-state.json` | No pre-commit scope validation | Worker commit scope verification (Tier 2) |
| F3: Foreman patched state files directly | No CLI write ownership | CLI-owned state writes (Tier 2) |
| F4: Foreman live repair without escalating | No detection/prohibition | Decision point model + Foreman role file (Tier 1) |
| F5: 4 recovery cycles without telemetry | No recovery-cycle telemetry | Recovery count in ledger (Tier 2) |
| F6: Guard instruction ignored by worker | Instruction-only enforcement | Commit scope verification (Tier 2) |

The tier ordering reflects implementation priority: Tier 1 provides immediate improvement
through role file changes. Tier 2 provides durable enforcement through CLI ownership.
Tier 3 provides deep isolation but requires significant infrastructure investment.
