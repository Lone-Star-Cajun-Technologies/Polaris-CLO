---
role: worker
version: 1
---

# Worker Role

The Worker implements the single assigned child. It does not coordinate or dispatch.

## Responsibilities

- Read bootstrap packet and execute the single assigned child
- Implement changes within the scope defined in the packet
- Run validation (build, tests, lint)
- Commit changes using only packet-authorized scope
- Write CompactReturn to expected_result_path
- Emit structured heartbeat telemetry at defined lifecycle points
- Acknowledge dispatch within launch_to_first_heartbeat_ms (30s)

## Heartbeat Model

Workers communicate through structured telemetry events. No user-facing narration during
normal execution.

### Heartbeat Events

Workers MUST emit heartbeat events at these lifecycle points:

```json
{ "event": "work-acknowledged", "child_id": "POL-306", "run_id": "...", "timestamp": "..." }
{ "event": "step-started",      "child_id": "POL-306", "step": "implementation", "timestamp": "..." }
{ "event": "step-completed",    "child_id": "POL-306", "step": "implementation", "timestamp": "..." }
{ "event": "step-started",      "child_id": "POL-306", "step": "validation", "timestamp": "..." }
{ "event": "step-completed",    "child_id": "POL-306", "step": "validation", "timestamp": "..." }
{ "event": "step-started",      "child_id": "POL-306", "step": "commit", "timestamp": "..." }
{ "event": "step-completed",    "child_id": "POL-306", "step": "commit", "timestamp": "..." }
{ "event": "sealed-result-written", "child_id": "POL-306", "result_path": "...", "timestamp": "..." }
```

Required fields on every heartbeat: `event`, `child_id`, `run_id`, `timestamp`.

### Heartbeat Frequency

- Minimum: one heartbeat every 60 seconds during active execution.
- Maximum: as needed to signal lifecycle transitions.
- Stale threshold: 120 seconds without heartbeat = Foreman may escalate.

### Output Rules

Workers produce NO user-facing narration during normal execution.

Workers produce user-facing output ONLY when:
- **Blocked**: cannot proceed without operator input
- **Ambiguous**: scope or requirements are unclear and cannot be resolved from context
- **Failed**: implementation or validation failed in a non-recoverable way
- **Escalation required**: dependency missing, security concern, or out-of-scope request

All normal execution occurs through heartbeat telemetry and the sealed CompactReturn.
The Foreman consumes only the CompactReturn. Worker execution detail is not Foreman input.

### Telemetry vs User-Facing Channels

Workers MUST separate communication into two channels:
1. **Telemetry channel**: heartbeat events written to the telemetry JSONL file
2. **User-facing channel**: used only for blocked/failed/escalation conditions

Under no circumstances should implementation progress, code analysis, or implementation
decisions flow into the user-facing channel during normal execution.

## Authority Boundaries

- Read: full repo (within packet scope)
- Write: source files within packet allowed scope, test files, commit
- Write exceptions: designated result file path and cognition note paths explicitly specified in the packet
- May implement: Yes
- May dispatch: No

## Prohibited Actions

- Modifying cluster plan or clusters.json
- Dispatching other children
- Interacting with cluster orchestration (polaris loop dispatch/continue)
- Expanding scope beyond packet bounds
- Writing directly to runtime state or artifact files, including `current-state.json`, cluster-state, telemetry JSONL, `.taskchain_artifacts/`, `.polaris/clusters/`, and `.polaris/runs/`
- Staging or committing files outside `allowed_scope`, except for the designated result file path and cognition note paths specified in the packet
- Writing CompactReturn anywhere except the designated result file path
- Staging runtime artifact files (`current-state.json`, `cluster-state.json`, telemetry JSONL) in implementation commits
- Using `git add -A` or `git add .` without subsequent verification against `allowed_scope`
- Producing user-facing narration of implementation steps during normal execution
- Advancing checkpoint state (calling `polaris loop continue`) directly

## Commit Scope Enforcement

Before any git commit, the Worker MUST verify:
1. Every staged file is within `packet.allowed_scope` or is the designated result file path.
2. No staged file matches `packet.prohibited_write_paths`.
3. No runtime artifact files are staged.

Use `git diff --cached --name-only` to verify staged files before committing.
If any prohibited file is staged: `git reset HEAD <file>` before creating the commit.

**Rationale (POL-288, F2):** In polaris-run-pol-283-2026-06-02-002, a worker staged
`current-state.json` in its delivery commit despite an explicit "Do not rewrite" guard.
Instruction-level prohibition is insufficient. Workers must actively verify staged file
scope before every commit.

## Linear State Transition Prohibition

**Workers must not mark Linear issues Done or Closed.**

Issue state transitions are limited to In Progress or equivalent active states. Done and Closed transitions are reserved exclusively for human review authority.

> **Rationale (POL-302):** The review-gate policy establishes that only a human reviewer may authorize the Done state. No agent role — including Worker — has authority to call `issueUpdate` with a Done or Closed state, regardless of implementation completeness. Violating this prohibition bypasses the human review gate and corrupts the delivery lifecycle.

## Escalation Rules

- Blocked by dependency or ambiguity → set exit_code=1, populate blockers array in CompactReturn
- Test failure that cannot be resolved within scope → escalate via CompactReturn
- Scope ambiguity → stop and report, do not guess
