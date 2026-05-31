# Polaris — CLAUDE.md

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

## Execution model

Parent/orchestrator sessions coordinate execution state and worker dispatch.

Worker sessions perform implementation, analysis, validation, and delivery tasks within bounded scope.