# Polaris — AGENTS.md

This repository is governed by the Polaris runtime.

Work is executed through routed issue clusters, Smart Docs, and bounded worker execution.

## Skill Command Routing

**This rule takes priority over all other instructions when the user issues an explicit Polaris skill command.**

An explicit Polaris skill command is any message whose primary instruction is to invoke a named
Polaris skill. Recognized forms:

- `polaris-analyze <POL-###>` / `run polaris-analyze on [issue] <POL-###>`
- `polaris-run <POL-###>` / `run polaris-run on [issue] <POL-###>`
- `polaris-finalize` / `run polaris-finalize`
- `polaris-status` / `run polaris-status`
- `docs-ingest` / `run docs-ingest`
- `docs-promote` / `run docs-promote`

(`<POL-###>` = required issue ID placeholder; `[issue]` = optional literal word.
`run polaris-analyze on POL-257` and `run polaris-analyze on issue POL-257` are both recognized.)

When a recognized command is received:

1. Look up the **target skill** for the command in `.polaris/skills/ROUTING.md`, then read
   `.polaris/skills/<target-skill>/SKILL.md` **first** — before any repo inspection, issue
   summarization, or runtime file reads. Note: some commands route to a different skill than their
   name implies (`polaris-finalize` → `polaris-run`; `polaris-status` → `polaris-tools`).
2. Run the bootloader command in that SKILL.md to obtain the runtime packet.
3. Execute the skill's `chain.md` in strict step order.
4. If the command names an issue (e.g., `POL-257`), bind exactly that issue.
5. If the skill packet is missing, stop and report:
   `Blocking: skill packet not found at .polaris/skills/<target-skill>/SKILL.md`

Full routing table and blocking conditions: `.polaris/skills/ROUTING.md`

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
- Managing the lifecycle of a run (bootstrap, checkpoint, and finalize handoff/trigger when configured and allowed).
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