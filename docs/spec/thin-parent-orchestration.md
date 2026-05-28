# Thin-Parent Orchestration and Sealed Execution Model

This document specifies the architecture for a thin-parent orchestration model in Polaris. The primary goal is to create a clear separation of concerns between the parent orchestrator and child workers, minimizing context pressure on the parent and enabling robust, repeatable, and automatable execution of complex tasks.

## 1. Core Principles

### 1.1. Thin Parent

The parent orchestrator's role is strictly limited to high-level state management and delegation. It does not perform any implementation, repository exploration, or deep cognitive work.

**Parent Responsibilities:**
- Initialize the run state from a Linear cluster.
- Select the next eligible child issue based on the defined order.
- Dispatch the child to a worker using a standardized "Worker Packet".
- Checkpoint the run state after a child worker completes and returns its result.
- Finalize the entire run (e.g., creating a pull request) when all children are complete.
- Report concise, high-level status to the user.

**Prohibited Parent Actions:**
- Writing or modifying source code, tests, or configuration.
- Browsing the repository filesystem.
- Interpreting the meaning of code or documentation.
- Engaging in conversational reasoning or planning outside of its state machine.

### 1.2. Sealed Execution

The parent operates within a "sealed" execution model. Between dispatching a child and receiving its completion, the parent is effectively dormant. It performs no autonomous actions. This ensures a predictable and auditable workflow.

**State Machine Transitions:**
The parent's lifecycle is a simple, deterministic state machine:

```
[Start] -> [Initialized] -> [Child Dispatched] -> [Waiting for Worker] -> [Child Completed] -> [State Checkpointed] -> [Select Next Child | Finalize]
```

- **Dispatch Boundary:** A hard boundary enforced by the runtime. A parent cannot proceed to the next child without a successful `dispatch` -> `continue` cycle.
- **No Inline Execution:** The parent is forbidden from executing child work directly. All implementation is delegated.

### 1.3. Worker-Owned Cognition

The child worker owns all repository-level cognition and implementation. It receives a focused "Worker Packet" and is responsible for understanding the task, modifying the code, running validation, and committing the result.

## 2. Execution Modes

The orchestration model supports two primary modes, configurable at the run level.

### 2.1. Supervised Mode

This is the default mode, designed for interactive sessions with an operator.
- The loop stops after each child is completed, awaiting operator confirmation to proceed.
- The operator can inspect the changes, provide feedback, or intervene if necessary.
- Final delivery (e.g., opening a PR) requires an explicit user command.

### 2.2. Auto Mode

Designed for unattended, end-to-end execution (e.g., in CI/CD or for long-running tasks).
- The loop continues automatically to the next child as long as the previous one was successful.
- The run proceeds from the first child to final delivery without operator intervention.
- Notifications are compact and designed for logs rather than interactive chat.

#### Auto Finalize Handoff

When `orchestration.mode` is `auto` and `orchestration.auto_finalize` is `true`, the parent emits an explicit **auto-finalize handoff** after cluster completion. This handoff records that the next step is `polaris finalize run`.

The parent still does not inspect repository content or perform implementation cognition. Worker sessions own repository cognition; the parent only dispatches, checkpoints, reports high-level status, and signals/permits finalization according to configuration.

## 3. Worker Packets

Communication from parent to child is done via a `WorkerPacket`. This is a self-contained JSON object that provides the worker with everything it needs.

**Packet Contents:**
- **Issue Payload:** The full title, description, and metadata of the child issue.
- **Scope:** Allowed file paths or modules for modification.
- **Execution Template:** A pre-defined set of steps for the worker to follow (e.g., "implement, then test, then commit").
- **Validation Requirements:** A list of commands the worker must execute to validate its work.
- **Contextual Docs:** Snippets from relevant `POLARIS.md` or `SUMMARY.md` files to provide local guidance.

The parent assembles this packet but does not interpret its contents.

## 4. User Experience (UX) and Notifications

### 4.1. Interactive/Supervised UX

In supervised mode, the orchestrator provides clear, step-by-step narration for the operator.

### 4.2. Headless/Auto UX (SSH & CI)

In auto mode, output is terse and structured, suitable for logging and monitoring in non-interactive environments.

**Example Terse Output:**
```
[POLARIS] DISPATCH POL-158
[POLARIS] COMPLETE POL-158 (commit: a1b2c3d)
[POLARIS] DISPATCH POL-159
...
[POLARIS] BLOCKED POL-160: Test failure in 'npm run test:unit'
```

## 5. Failure Recovery

The sealed model simplifies failure recovery. Since state is checkpointed after each child, a run can be resumed from the last successful checkpoint.

- **Interrupted Runs:** A run can be restarted, and it will automatically resume from the last `continue` checkpoint.
- **Child Failures:** If a child fails validation or crashes, the run enters a `blocked` state. An operator can fix the issue and then resume the run.

## 6. Governance and Root Instructions

The root instructions for the agent (`AGENTS.md`, `CLAUDE.md`, etc.) will be updated to be role-aware.
- **Parent Role:** Instructions will guide the agent to act as a thin orchestrator, adhering to the sealed execution model.
- **Worker Role:** Instructions will guide the agent to focus on the implementation task defined in the Worker Packet.
This prevents agent "role confusion" and enforces the architectural boundary.
