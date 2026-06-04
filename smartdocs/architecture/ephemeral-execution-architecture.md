---
source: smartdocs/docs/raw/ephemeral-execution-architecture.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-05-28-002
classified-as: architecture
linked-map-area: .taskchain_artifacts/polaris-run/current-state.json
ingested-at: 2026-05-28T06:22:37.632Z
status: raw
---

# Ephemeral Execution Architecture

## Purpose

Polaris ephemeral execution runs each implementation child in a fresh agent or operator session. The parent session keeps durable state, dispatches exactly one child, and expects only a compact completion result before the next step resumes.

The model is:

1. Agent A or the operator selects the next valid child, writes a bootstrap handoff packet, records telemetry, and exits or waits idle.
2. Agent B reads the packet, executes exactly one child issue, commits the child work, updates durable run state, writes a compact result, and exits.
3. Agent C or the operator resumes from `current-state.json`, reads the result, selects the next open child, and repeats the same bounded flow.

No agent depends on inherited chat context from a previous agent. The git branch, run ledger, telemetry file, Linear issue state, and bootstrap packet are the continuation boundary.

## Execution Flow

The parent loop executes one child per worker:

1. Orient to the IMPLEMENT parent and verify that the active parent is not an ANALYZE issue.
2. Select the lowest-numbered open child whose blockers are satisfied.
3. Persist `active_child`, `next_open_child`, `current_step_id`, and `step_cursor` in `.taskchain_artifacts/polaris-run/current-state.json`.
4. Build a bootstrap packet with enough context for a fresh worker to continue safely.
5. Dispatch the packet through an adapter, or write manual handoff instructions when automatic dispatch is unavailable.
6. Stop the old agent/session after successful handoff. It must not keep implementing, select another child, or mutate files while the worker owns the child.
7. The worker executes only the child named in the packet, validates acceptance criteria, commits exactly one child commit, updates Linear, updates state and telemetry, writes the compact result, and exits.
8. A later session resumes from durable state and chooses the next valid child.

If dispatch fails before a worker claims the child, the parent records the failure and keeps the child open. If the worker claims the child and then fails, the result must record the failure mode and the run must stop for operator intervention.

## `AgentSubtaskAdapter.dispatch()` Contract

`AgentSubtaskAdapter.dispatch()` is the native same-agent adapter for Claude and Claude Code environments that expose a subtask or TaskCreate primitive. It must not shell out to another provider by default.

Input:

- `bootstrapPacket`: the complete packet described below.
- `childId`: the single child issue to execute.
- `runId`: the current Polaris run identifier.
- `repoRoot`: absolute repository path.
- `stateFile`: path to the authoritative run ledger.
- `telemetryFile`: path to JSONL telemetry.
- `returnContract`: the compact fields the worker must return.

Behavior:

- Create one native subtask with instructions to execute only `childId`.
- Include the bootstrap packet in the subtask prompt or task metadata.
- Require the subtask to return only the compact result, not its transcript.
- Wait for the subtask to finish or fail.
- Surface timeout, cancellation, or malformed result as a dispatch failure.
- Never dispatch a second child from the same call.

Result:

```json
{
  "child_id": "POL-107",
  "status": "done",
  "commit_hash": "abcdef1",
  "validation_summary": "issue validation passed",
  "next_action": "resume-parent",
  "warnings": []
}
```

The adapter may keep provider-specific handles internally, but the result contract remains provider-neutral.

## Claude and Claude Code Path

Claude-native execution uses `AgentSubtaskAdapter.dispatch()` when the host exposes native TaskCreate/subagent support. The parent session passes the bootstrap packet to the subagent and then stops acting on the repository until the subagent completes.

Claude Code without native subtask support must use the manual handoff or terminal adapter path. It must not simulate native dispatch by starting recursive agent CLIs unless explicit configuration allows that adapter.

## Codex Plugin Path

Codex currently cannot be assumed to auto-spawn a fully independent new Codex session from inside a worker. The Codex plugin path therefore has two modes:

- `manual-handoff`: Polaris writes the bootstrap packet and exact worker instructions. The operator starts a new Codex session and gives it the packet. This is the default Codex-safe path.
- `terminal-cli`: If a configured Codex CLI provider exists and the environment explicitly allows subprocess dispatch, Polaris may invoke that provider with the packet through stdin, `POLARIS_PACKET_FILE`, or equivalent environment variables.

The Codex path must preserve the same one-child result contract. If automatic Codex session spawning becomes available later, it should be added as an adapter capability, not hardcoded into the parent loop.

## Manual Operator Handoff Fallback

Manual fallback is the required recovery and portability path. Polaris writes:

- The bootstrap packet path.
- The branch name and repository path.
- The exact child issue identifier.
- The validation commands.
- The compact final response expected from the worker.

The operator starts a fresh agent or manual coding session, supplies the packet, and instructs the worker to execute exactly one child. The old session exits or stays read-only. After the worker finishes, the operator resumes the parent loop from `current-state.json`.

Manual fallback is valid for Claude, Codex, or any other environment when native dispatch is unavailable.

## Bootstrap Packet Fields

Ephemeral mode extends the existing `BootstrapPacket` shape. Required fields:

- `schema_version`: packet schema version.
- `run_id`: durable Polaris run identifier.
- `skill`: workflow skill, usually `polaris-run`.
- `cluster_id`: IMPLEMENT parent issue.
- `child_id`: the only child the worker may execute.
- `branch`: required git branch.
- `repo_root`: absolute repository path.
- `base_commit_sha`: commit at dispatch time.
- `last_completed_step`: previous run step.
- `last_completed_child`: most recently completed child, if any.
- `next_step`: next step the worker should execute.
- `open_children`: ordered remaining child identifiers.
- `blocked_children`: children blocked by incomplete dependencies.
- `artifact_pointers.current_state`: path to `current-state.json`.
- `artifact_pointers.telemetry`: path to `telemetry.jsonl`.
- `artifact_pointers.bootstrap_packet`: path to the packet itself.
- `context_budget.children_completed`: completed child count.
- `context_budget.files_touched_total`: cumulative touched-file count.
- `context_budget.stop_threshold_remaining`: remaining child budget for the current run.
- `current_state_sha`: checksum or hash for stale-state detection.
- `allowed_changes`: file or directory allowlist for this child.
- `validation_commands`: child-specific validation commands.
- `return_summary_contract`: required compact result fields.
- `execution_adapter`: selected adapter, fallback order, and auto-dispatch capability.
- `boundary_enforcement`: explicit one-child and no-next-child execution rule.
- `resume_instructions`: human-readable instruction for the next parent session.

Workers must reject packets with missing `child_id`, branch mismatch, stale `current_state_sha`, or allowed-change scope that conflicts with the issue.

## MCP Contracts

Ephemeral mode can use MCP operations when the parent and worker do not share process memory.

### Claim

`polaris_claim_child` (MCP tool name; conceptual alias: `polaris.ephemeral.claim`) reserves one child for one worker.

Input:

- `run_id`
- `cluster_id`
- `child_id`
- `worker_id`
- `current_state_sha`

Output:

- `claim_id`
- `status`: `claimed`, `already_claimed`, `stale_state`, or `blocked`
- `bootstrap_packet`

The operation must be atomic. A second worker cannot claim the same child unless the previous claim is released or expires by policy.

### Dispatch

`polaris_dispatch_child` (MCP tool name; conceptual alias: `polaris.ephemeral.dispatch`) creates or records a handoff.

Input:

- `claim_id`
- `adapter`
- `bootstrap_packet`
- `manual_handoff_required`

Output:

- `dispatch_id`
- `status`: `dispatched`, `manual_handoff_written`, or `failed`
- `handoff_path`
- `warnings`

Dispatch does not mark the child complete. It only records that a worker can begin.

### Result

`polaris_dispatch_result` (MCP tool name; conceptual alias: `polaris.ephemeral.result`) records the worker outcome.

Input:

- `claim_id`
- `dispatch_id`
- `child_id`
- `status`: `done`, `failed`, `blocked`, or `aborted`
- `commit_hash`
- `validation_summary`
- `state_file_sha`
- `telemetry_event_ids`
- `warnings`

Output:

- `accepted`
- `next_open_child`
- `required_operator_action`

The result operation rejects missing commits for `done`, invalid child ids, stale state hashes, and results that imply more than one child was executed.

## Safety Limits

Ephemeral execution has hard limits:

- One child per worker.
- One child commit per child.
- No automatic execution of a higher-numbered child while a lower-numbered open sibling exists.
- No automatic continuation from an analyze child into implementation work.
- No parallel child execution unless a future design adds explicit dependency-safe partitioning.
- No source or docs changes outside the child allowlist.
- No cross-agent fallback unless explicitly configured.
- No retry loop without operator approval.
- Stop on blocker, stale state, dirty unexpected files, validation failure, malformed result, or Linear update failure.
- Parent sessions may select and dispatch; worker sessions may execute; neither may do both for multiple children in one run turn.

These limits prevent runaway multi-child execution and keep reviewable ownership boundaries.

## Bounded Test Plan

The test plan uses a real issue set with one IMPLEMENT parent and three small ordered children. Success criteria and failure modes must be recorded in telemetry.

1. Manual fallback smoke test:
   - Parent writes a packet for child 1 and exits.
   - A fresh manual or Codex worker reads the packet, edits only the allowed file, commits, updates state, writes result, and exits.
   - Success: parent resume sees child 1 done and selects child 2.
   - Failure modes: missing packet field, stale branch, unexpected dirty files, or worker edits outside scope.

2. Claude native `AgentSubtaskAdapter.dispatch()` test:
   - Parent dispatches child 2 through native TaskCreate/subtask support.
   - Success: subtask returns only the compact result, state records one completed child, and no transcript is required by the parent.
   - Failure modes: subtask unavailable, timeout, malformed result, or multiple-child execution attempt.

3. MCP claim and result test:
   - Two workers attempt to claim child 3.
   - Success: only one claim succeeds; the accepted result advances `next_open_child`.
   - Failure modes: double claim accepted, stale state accepted, result without commit accepted, or blocked child selected.

4. Runaway prevention test:
   - Worker is instructed to continue to the next child after finishing its assigned child.
   - Success: worker refuses, result records one child only, and parent remains responsible for next selection.
   - Failure modes: second child changed, second commit created, or state advances by more than one child.

The bounded validation is complete when all paths demonstrate fresh-agent continuation, durable state recovery, one-child enforcement, explicit manual fallback, and clear failure reporting.
