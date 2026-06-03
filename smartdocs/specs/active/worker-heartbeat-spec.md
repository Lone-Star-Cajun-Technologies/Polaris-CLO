---
kind: spec
status: active
source: closeout-librarian-runtime
created: 2026-06-03
depends_on:
  - foreman-worker-architecture.md
  - worker-session-contract.md
  - worker-telemetry-spec.md
source_paths:
  - .polaris/roles/worker.md
related:
  - pol-288-foreman-worker-drift-postmortem.md
---

# Worker Heartbeat Model Specification

**Status:** Authoritative spec
**Created:** 2026-06-03
**Evidence:** polaris-run-pol-283-2026-06-02-002 (POL-288 postmortem)

---

## 1. Problem Statement

Workers currently produce too much visible activity that flows into the Foreman's context.
When the terminal-cli adapter uses `stdio: "inherit"`, the full worker stdout/stderr
becomes part of the Foreman's context window.

The POL-288 postmortem confirmed 21.7M cached tokens in a single run due to this pattern.
Worker implementation details are not Foreman input. Workers should communicate through
structured telemetry events and the sealed CompactReturn only.

---

## 2. Heartbeat Event Model

Workers communicate through structured telemetry events emitted at lifecycle boundaries.

### 2.1 Mandatory Heartbeat Events

Workers MUST emit these events during execution:

| Event | When | Required Fields |
|---|---|---|
| `work-acknowledged` | Immediately upon reading packet | `child_id`, `run_id`, `dispatch_id`, `timestamp` |
| `step-started` | Beginning each major step | `child_id`, `run_id`, `step`, `timestamp` |
| `step-completed` | Completing each major step | `child_id`, `run_id`, `step`, `timestamp`, `outcome` |
| `validation-started` | Before running validation commands | `child_id`, `run_id`, `timestamp` |
| `validation-completed` | After all validation commands | `child_id`, `run_id`, `timestamp`, `outcome`, `commands_run` |
| `commit-started` | Before `git commit` | `child_id`, `run_id`, `timestamp` |
| `commit-completed` | After successful commit | `child_id`, `run_id`, `timestamp`, `commit_sha` |
| `sealed-result-written` | After writing CompactReturn | `child_id`, `run_id`, `result_path`, `timestamp` |

### 2.2 Event Schema

```json
{
  "event": "<event-name>",
  "child_id": "POL-306",
  "run_id": "polaris-run-...",
  "dispatch_id": "<uuid>",
  "step": "<optional: current step name>",
  "timestamp": "2026-06-03T00:00:00.000Z",
  "outcome": "<optional: success|failure|skipped>",
  "data": {}
}
```

Required fields on every event: `event`, `child_id`, `run_id`, `timestamp`.

### 2.3 Heartbeat Frequency

- Minimum: one heartbeat every 60 seconds during active execution.
- Recommended: emit `step-started` / `step-completed` at logical boundaries.
- Stale threshold: 120 seconds without heartbeat = Foreman may escalate.

### 2.4 Telemetry Write Path

Workers write heartbeat events by appending JSON lines to the telemetry JSONL file
specified in their packet: `packet.telemetry_file`.

Workers MUST NOT:
- Create a new telemetry file (append-only)
- Rewrite the telemetry file
- Read the telemetry file
- Write to a different telemetry path

---

## 3. Output Rules

### 3.1 No User-Facing Narration During Normal Execution

Workers produce NO user-facing output during normal implementation.

All progress communication occurs through heartbeat events (telemetry channel).
The Foreman sees only the CompactReturn after the worker completes.

### 3.2 User-Facing Output Triggers

Workers produce user-facing output ONLY when:

| Condition | Output Type |
|---|---|
| Blocked (cannot proceed without operator input) | Blocker description |
| Ambiguous (scope unclear, cannot resolve from packet) | Ambiguity description |
| Failed (non-recoverable implementation or validation failure) | Failure description |
| Escalation required (dependency missing, security concern) | Escalation request |

### 3.3 Structured Telemetry vs User-Facing Channels

```text
Telemetry channel:     heartbeat JSONL events → telemetry.jsonl
User-facing channel:   blocked/failed/escalation only → agent output
```

These are separate. Implementation progress does not go to the user-facing channel.

---

## 4. Commit Scope Enforcement

Workers must verify staged files before every git commit.

### 4.1 Pre-Commit Checklist

Before `git commit`, the worker MUST:
1. Run `git diff --cached --name-only` to list staged files.
2. Verify every staged file is in `packet.allowed_scope`.
3. Verify no staged file matches `packet.prohibited_write_paths`.
4. Verify no runtime artifact is staged:
   - `.taskchain_artifacts/polaris-run/current-state.json`
   - `.polaris/clusters/*/cluster-state.json`
   - `.polaris/runs/ledger.jsonl`
   - `**/telemetry.jsonl`

If any violation: `git reset HEAD <file>` before committing.

### 4.2 Git Add Prohibition

Workers MUST NOT use:
- `git add -A`
- `git add .`

Without immediately following with `git diff --cached --name-only` verification.

These commands stage ALL modified files, which routinely includes runtime artifacts.

### 4.3 Rationale (POL-288, F2)

In polaris-run-pol-283-2026-06-02-002, a Copilot worker staged `current-state.json` in
its delivery commit despite an explicit "Do not rewrite current-state.json" guard injected
by the Foreman. The instruction was ignored because the worker used `git add -A` or similar.

Pre-commit verification makes this failure visible to the worker before committing.

---

## 5. Foreman Supervision Model

### 5.1 What the Foreman Supervises

- Heartbeat liveness (is the worker still alive?)
- CompactReturn (sealed result)

The Foreman does NOT supervise:
- Worker implementation activity
- Worker file edits
- Worker test results (only CompactReturn validation outcome)
- Worker commit message content (only commit SHA)

### 5.2 Heartbeat Supervision

| Condition | Foreman Action |
|---|---|
| Heartbeat fresh (< 120s) | Continue waiting (quiet) |
| Heartbeat stale (> 120s) | Escalate with options (quiet mode exception) |
| Worker completed (CompactReturn received) | Validate CompactReturn, checkpoint |

When heartbeat is stale, Foreman presents escalation (quiet mode exception):

```text
Issue: Worker heartbeat expired. No heartbeat received in 120+ seconds.
Last known step: <step from last heartbeat>

Options:
1. Keep waiting (extend timeout)
2. Stop worker
3. Mark blocked and halt
4. Create Medic triage note

How would you like to proceed?
```

The Foreman DOES NOT inspect implementation details to determine what happened.
The last heartbeat step is the maximum knowledge the Foreman has.

---

## 6. Implementation Requirements

### 6.1 Instruction-Level (Implemented)

Updated in `.polaris/roles/worker.md`:
- Heartbeat event schema
- Output rules
- Commit scope enforcement
- Prohibited write paths

### 6.2 Runtime Enforcement (Future)

| Enhancement | Mechanism | Target |
|---|---|---|
| Worker scope fidelity check | `continue.ts` emits `worker-scope-fidelity` event | `src/loop/continue.ts` |
| CompactReturn-only adapter mode | `terminal-cli.ts` extracts CompactReturn, suppresses other output | `src/loop/adapters/terminal-cli.ts` |
| Pre-commit hook | Worker runs Polaris commit validation before git commit | `npm run polaris -- worker commit` |
| Telemetry append validation | CLI validates telemetry JSONL is append-only | `src/runtime/audit/logger.ts` |
