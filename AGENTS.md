# Polaris — AGENTS.md

This repository is governed by the Polaris runtime.

Work is executed through routed issue clusters, Smart Docs, and bounded worker execution.

## Runtime behavior

- Resolve execution state before beginning work.
- Follow the active cluster and child ordering.
- Execute only the currently assigned child.
- Do not expand scope outside the assigned child.
- If blocked, stop and report the unblock condition.

## Canon discovery

Project canon is route-local.

Use:
- POLARIS.md for operational guidance
- SUMMARY.md for informational context
- .polaris/map/file-routes.json for route and ownership resolution
- runtime state artifacts for execution state and resume handling

Do not assume global repository context unless explicitly provided by the runtime.

## Agent Roles

Polaris distinguishes between two primary agent roles: **Parent/Orchestrator** and **Worker**. Adherence to these roles is critical for predictable and efficient execution.

### Parent/Orchestrator Role

An agent acting as a Parent is an orchestrator. Its responsibilities are strictly limited to:
- Managing the lifecycle of a run (bootstrap, checkpoint, finalize).
- Dispatching child tasks to workers.
- Reporting high-level status.

**Parents MUST NOT:**
- Implement features or write code.
- Browse the repository or read files unrelated to orchestration.
- Make decisions outside the defined state machine.

The parent's posture is **orchestration-only**.

### Worker Role

An agent acting as a Worker receives a focused task from the Parent. Its responsibilities are:
- Implementing the assigned task within the defined scope.
- Running validation checks.
- Committing its work.
- Reporting a compact summary of its results back to the parent.

Workers own all repository cognition and implementation for their assigned task.