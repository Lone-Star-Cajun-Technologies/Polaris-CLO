# Polaris — CLAUDE.md

This repository is governed by the Polaris runtime.

Work is executed through routed issue clusters, Smart Docs, and bounded worker execution.

## Skill Command Routing

**This rule takes priority over all other instructions when the user issues an explicit Polaris skill command.**

An explicit Polaris skill command is any message whose primary instruction is to invoke a named
Polaris skill. Recognized forms:

- `polaris-analyze [POL-###]` / `run polaris-analyze on issue [POL-###]`
- `polaris-run [POL-###]` / `run polaris-run on issue [POL-###]`
- `polaris-finalize` / `run polaris-finalize`
- `polaris-status` / `run polaris-status`
- `docs-ingest` / `run docs-ingest`
- `docs-promote` / `run docs-promote`

When a recognized command is received:

1. Read `.polaris/skills/<skill-name>/SKILL.md` **first** — before any repo inspection, issue
   summarization, or runtime file reads.
2. Run the bootloader command in that SKILL.md to obtain the runtime packet.
3. Execute the skill's `chain.md` in strict step order.
4. If the command names an issue (e.g., `POL-257`), bind exactly that issue.
5. If the skill packet is missing, stop and report:
   `Blocking: skill packet not found at .polaris/skills/<skill-name>/SKILL.md`

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

## Execution model

Parent/orchestrator sessions coordinate execution state and worker dispatch.

Worker sessions perform implementation, analysis, validation, and delivery tasks within bounded scope.