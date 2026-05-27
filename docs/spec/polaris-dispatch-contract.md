# Polaris Dispatch Contract

Authoritative specification for the parent/worker boundary used by Polaris loop dispatch. This contract defines parent responsibilities, worker responsibilities, lifecycle states, command boundaries, worker prompt requirements, telemetry cadence, and invariants.

Implementation reference files:

- `src/loop/dispatch.ts`
- `src/loop/continue.ts`
- `src/loop/parent.ts`
- `src/loop/worker-prompt.ts`

---

## 1. Parent/Orchestrator Responsibilities

The parent/orchestrator owns child selection, dispatch, return validation, run-state persistence, and continuation decisions. It does not own child implementation.

### Required behavior

| Responsibility | Requirement |
|---|---|
| Session startup | Load durable run state and verify the active parent cluster. |
| Child selection | Select exactly one eligible child according to cluster ordering and blockers. |
| Dispatch boundary | Dispatch the selected child through the configured execution adapter. |
| Return validation | Validate the worker return before recording completion. |
| Completion record | Record child completion only after the worker has returned and validation has passed. |
| Continuation decision | Decide whether to dispatch another child, stop, or finalize after the checkpoint. |

### Prohibited behavior

- The parent must not implement child work inline.
- The parent must not use `polaris loop continue` as dispatch.
- The parent must not mark a child complete before the worker returns.
- The parent must not select or execute sibling children while a worker owns the active child.
- The parent must not mutate implementation files on behalf of the worker.

The parent loop implementation in `src/loop/parent.ts` owns the orchestration lifecycle. The checkpoint and resume logic in `src/loop/continue.ts` must remain a post-child parent action, not a substitute for explicit dispatch.

## 2. Worker Responsibilities

The worker owns exactly one assigned child issue. It receives the prompt produced from the canonical template in `src/loop/worker-prompt.ts`, performs the bounded child work, reports back, and terminates.

### Required behavior

| Responsibility | Requirement |
|---|---|
| Child scope | Execute only the assigned child issue. |
| Worktree scope | Work only in the assigned worktree and branch. |
| File scope | Respect the explicit allowed-write scope in the prompt. |
| Validation | Run the requested child-level validation or report why it could not run. |
| Report-back | Return the compact completion packet requested by the prompt. |
| Termination | Terminate after one child. |

### Prohibited behavior

- The worker must not work on sibling children.
- The worker must not mutate parent state, parent run ledgers, parent delivery artifacts, Linear parent status, or git metadata unless the prompt explicitly grants that child-level responsibility.
- The worker must not call `polaris loop continue`.
- The worker must not dispatch another worker.
- The worker must not continue into parent delivery or finalization.

## 3. State Machine

The Polaris dispatch lifecycle has this exact state order:

```text
session-start -> select-child -> DISPATCH -> child-executing -> worker-returned -> validate-return -> record-completion -> decide-next
```

| State | Owner | Meaning |
|---|---|---|
| `session-start` | Parent | Load state, verify cluster, and establish run context. |
| `select-child` | Parent | Choose the single eligible child to execute. |
| `DISPATCH` | Parent | Invoke the execution adapter with the child prompt and boundary contract. |
| `child-executing` | Worker | Perform only the assigned child work. |
| `worker-returned` | Worker then parent | Worker reports completion, blocked, or failed status and terminates. |
| `validate-return` | Parent | Validate the worker return against acceptance criteria and scope. |
| `record-completion` | Parent | Persist completion, checkpoint telemetry, and run-state updates. |
| `decide-next` | Parent | Decide whether another dispatch is permitted, the run must stop, or delivery may proceed. |

`polaris loop continue` is positioned at `record-completion` only. It is a post-child checkpoint and resume command after the worker has returned; it is not a dispatch mechanism and must not be used to skip `DISPATCH`.

## 4. Dispatch Command Model

### `polaris loop dispatch`

`polaris loop dispatch` is the explicit parent/worker boundary. It claims the selected child (`active_child`), prepares the selected child packet, and records a `child-dispatched` event. Adapter execution starts child work at this boundary.

Dispatch responsibilities:

- Accept exactly one selected child.
- Claim exactly one child by setting `active_child` (and related dispatch cursor fields).
- Use the execution adapter rather than inline implementation.
- Pass the worker the issue identity, scope, validation, and report-back contract.
- Leave completion state unchanged until a worker return is validated.
- Preserve parent control of child ordering and next-step decisions.

Dispatch must never add to `completed_children`, must never remove the active child from `open_children`, must never advance to the next child, and must never mark child or cluster completion.

### `polaris loop continue`

`polaris loop continue` is a post-child checkpoint command. It runs after a worker has returned and the parent has validated that return.

Continue responsibilities:

- Read the durable run state.
- Persist checkpoint updates for the completed child.
- Recompute the next eligible child after completion has been recorded.
- Emit or refresh the bootstrap/resume packet for the parent loop.
- Stop at governance boundaries when required.

`polaris loop continue` must not be used as dispatch, must not implement child work inline, and must not claim that a child completed before a valid worker return exists.

## 5. Worker Prompt Template

`src/loop/worker-prompt.ts` is the canonical worker prompt template. The parent may add adapter-specific wrappers, but the child contract fields below are mandatory and must survive rendering unchanged in meaning.

| Field | Requirement |
|---|---|
| Issue id/title | Identify the exact child issue and title. |
| Worktree | Provide the absolute worktree path. |
| Branch | Provide the branch the worker must use. |
| Goal | State the child objective in bounded terms. |
| Scope | Define allowed reads, allowed writes, and prohibited surfaces. |
| Acceptance criteria | Include the child-specific acceptance criteria. |
| Helpers | List allowed helper commands, scripts, or reference files. |
| Validation | List required validation commands or validation expectations. |
| Commit format | State whether the worker may commit and the required commit message format if allowed. |
| Governance | Restate one-child execution, no sibling work, no parent mutation, and stop conditions. |
| Report-back | Define the compact final response fields the worker must return. |
| TERMINATE | Include an explicit instruction to terminate after reporting back. |

The prompt must be sufficient for a fresh worker session with no inherited chat context. Missing mandatory fields are a dispatch construction failure.

## 6. Telemetry Cadence

Telemetry uses checkpoint-only events. The parent records lifecycle boundaries; child completion/checkpoint events are emitted after worker return validation.

| Event | Owner | When |
|---|---|---|
| `session-start` | Parent | When a parent session begins or resumes. |
| `child-dispatched` | Parent | When the execution adapter accepts one child dispatch. |
| `child-complete` | Parent | After worker return validation and completion recording. |
| `loop-checkpoint` | Parent | When post-child checkpoint state is persisted. |
| `session-end` | Parent | When the parent stops, blocks, or finishes the governed session. |

Blocking-only extras are permitted when a blocker prevents forward progress, such as dispatch failure, malformed worker return, validation failure, scope violation, missing state, or unavailable adapter.

Telemetry must not become a transcript stream. It should record durable checkpoints and blocking facts only.

## 7. Invariants

- Dispatch must not mark child complete.
- Dispatch must not advance `completed_children`.
- The parent must not implement child work inline.
- The parent must not use `polaris loop continue` as dispatch.
- The worker must execute exactly one child.
- The worker must not work on sibling children.
- The worker must not mutate parent state.
- The worker must terminate after one child.
- `polaris loop continue` belongs at `record-completion` only.
- Completion may be recorded only after a worker return has been validated.
- Child ordering remains a parent responsibility.
- Execution adapter behavior must preserve provider-neutral parent/worker boundaries.
