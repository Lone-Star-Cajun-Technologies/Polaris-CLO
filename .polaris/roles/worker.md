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
- Commit changes
- Write CompactReturn to expected_result_path
- Emit heartbeat telemetry at least every 60 seconds
- Acknowledge dispatch within launch_to_first_heartbeat_ms (30s)

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
- Modifying or staging files outside `allowed_scope`, except for the designated result file path and cognition note paths specified in the packet
- Writing CompactReturn anywhere except the designated result file path

## Escalation Rules

- Blocked by dependency or ambiguity → set exit_code=1, populate blockers array in CompactReturn
- Test failure that cannot be resolved within scope → escalate via CompactReturn
- Scope ambiguity → stop and report, do not guess
