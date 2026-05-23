---
name: polaris-run-chain
description: Route map for polaris-run — step order, continuation rules, and artifact update requirements.
---

# polaris-run chain

## Step traversal order

```text
01-orient-cluster
02-select-child          ← loops back here after 05 decides CONTINUE
03-execute-child
04-commit-and-update-linear
05-advance-loop          → CONTINUE: go to 02 | STOP: halt and report | FINALIZE: run polaris finalize
```

## Continuation rules

After step 05 evaluates the session:

- **CONTINUE**: return to step 02 within the same session. Do not re-orient — use existing state.
- **STOP (budget)**: halt cleanly when any context budget threshold is met. Report completed child, commit hash, next open child ID, and the resume command: `polaris loop resume`.
- **STOP (blocked)**: follow the blocker protocol in step 04. Halt immediately. Do not skip to later children.
- **FINALIZE**: run `polaris finalize` when `open_children` is empty and all children are Done.

## Context budget

Track in `.polaris/runs/current-state.json` under `context_budget`. Update after each child completes.

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 3 → STOP |

## Artifact update requirement

After every completed step, update `.polaris/runs/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.polaris/runs/current-state.json` updated successfully.

If the artifact update fails, stop immediately and report the failure.

## Chain definition

Each cluster's children, types, and dependency order are defined in:

```
.polaris/clusters/<cluster-id>/chain.yaml
```

This file must exist before a first session can start. See `.polaris/clusters/chain-yaml-format.md` for the schema.
