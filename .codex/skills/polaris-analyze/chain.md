---
name: polaris-analyze-chain
description: Route map for polaris-analyze — step order, boundary enforcement, and artifact update requirements.
---

# polaris-analyze chain

## Step traversal order

```text
01-orient-cluster
02-select-child          ← loops back here after 05 decides CONTINUE
03-execute-child
04-commit-and-update-linear
05-advance-loop          → CONTINUE: go to 02 | BOUNDARY: halt (implement next) | FINALIZE: polaris finalize
```

## Continuation rules

After step 05:

- **CONTINUE**: return to step 02 within the same session. Next child must be `session_type: analyze`.
- **BOUNDARY**: halt when `polaris loop continue` fires the analyze→implement boundary enforcement event. Report the last completed analyze child and the first implement child. The operator must start a new polaris-run session.
- **STOP (budget)**: halt when context budget threshold is met. Report next open child and resume command: `polaris loop resume`.
- **FINALIZE**: run `polaris finalize` only when ALL cluster children (analyze and implement) are Done. This case applies only to analyze-only clusters.

## Context budget

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 3 → STOP |

## Scope enforcement

`polaris loop continue` reads `.polaris/session-type` to detect non-doc file mutations in the working tree. If implementation-scope changes are found, it halts with a scope violation event. This is structural enforcement — the skill does not replicate it manually.

## Artifact update requirement

After every completed step, update `.polaris/runs/current-state.json` before advancing.

A step is NOT complete until:
1. Operational action completed.
2. `.polaris/runs/current-state.json` updated successfully.

## Chain definition

Each cluster's children, types, and dependency order are defined in:

```
.polaris/clusters/<cluster-id>/chain.yaml
```

This file must exist before a first session can start. See `.polaris/clusters/chain-yaml-format.md` for the schema.
