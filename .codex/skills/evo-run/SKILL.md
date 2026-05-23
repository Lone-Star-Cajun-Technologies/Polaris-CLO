---
name: evo-run
description: Execute one governed EVO Linear parent cluster per fresh session, with bounded child execution inside the cluster.
---

# evo-run

Use this skill when the user asks to run a governed EVO Linear cluster or standalone EVO Linear issue.

## Related doctrine

See `docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md` for the linked-skills/task-chain composition boundary.

## How to execute

1. Read `chain.md` — it is the route map for this workflow.
2. Read `.taskchain_artifacts/evo-run/current-state.json` — it holds the shared runtime state across agents.
3. **Discover children:** Query `mcp2_list_issues(parentId: [parent-issue-id])` to find sub-issues. The parent issue response does NOT include children by default. If children exist, execute lowest-numbered open child first. If empty, treat as standalone.
4. Execute one step at a time in the order chain.md specifies.
5. After each step completes, update `.taskchain_artifacts/evo-run/current-state.json` before moving to the next step.
6. Do not skip steps.
7. Do not report completion until `.taskchain_artifacts/evo-run/current-state.json` reports completion.

## Artifact authority rule

`.taskchain_artifacts/evo-run/current-state.json` is the authoritative run ledger, not an optional note.

A step is not complete until its state update has been written successfully.

If the artifact update fails or cannot be verified, stop and report the artifact failure instead of continuing.
