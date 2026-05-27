# Ephemeral Execution Validation Plan

This plan defines the real validation harness for Polaris ephemeral execution after the in-process smoke test is passing.

## Real Test Issues

Use a dedicated Linear sandbox cluster, not an active production cluster:

- `POL-EPHEMERAL-VALIDATE-1`: `IMPLEMENT: Ephemeral validation parent` with `orchestration_mode: ephemeral`.
- `POL-EPHEMERAL-VALIDATE-2`: `IMPLEMENT: Ephemeral validation child writes marker doc`.

Use a separate guard cluster for rejection behavior:

- `POL-EPHEMERAL-GUARD-1`: `ANALYZE: Ephemeral guard parent`.
- `POL-EPHEMERAL-GUARD-2`: `IMPLEMENT: Unreachable guard child`.

## Success Criteria

- Running `polaris-run` against `POL-EPHEMERAL-GUARD-1` halts before dispatch with the documented ANALYZE-parent rejection message.
- Running `polaris-run` against `POL-EPHEMERAL-VALIDATE-1` dispatches exactly one child through the ephemeral `agent-subtask` path.
- The child writes only its marker file and the run ledger or telemetry artifacts required by `polaris-run`.
- `current-state.json` records the child in `completed_children`, clears `open_children`, clears `next_open_child`, updates `last_commit`, and increments `context_budget.children_completed`.
- `telemetry.jsonl` contains `child-dispatch` and `child-complete` events with `orchestration_mode: ephemeral` and `adapter: agent-subtask`.
- The child commit message begins with the child issue key.

## Failure Conditions

- Any real network or Linear call occurs during the real validation harness.
- An ANALYZE parent dispatches a child instead of halting.
- More than one child dispatches in the validation run.
- The parent loop executes child work inline instead of using the adapter.
- `current-state.json` is missing the completed child, keeps the completed child in `open_children`, or omits the final commit hash.
- Telemetry omits either the dispatch or completion event.
- The validation run touches files outside the marker file and run artifacts.

## Safety Limits

- Maximum children per real validation run: `1`.
- Maximum runtime per validation run: `10 minutes`.
- Use a dedicated branch and sandbox issue keys only.
- Do not target active implementation parents, customer-facing repos, or issue clusters with unresolved blockers.
- Stop immediately if telemetry shows more than one `child-dispatch` event for the run.

## Rollback Procedure

1. Stop the parent loop and do not run `polaris loop continue`.
2. Revert only the sandbox marker commit on the validation branch.
3. Restore the validation `current-state.json` from the pre-run copy captured before dispatch.
4. Append a telemetry note with the rollback reason and the restored state hash.
5. Comment on both validation issues with the failure condition, rollback commit, and next unblock condition.
