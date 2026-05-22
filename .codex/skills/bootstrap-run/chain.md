> TEMPORARY BOOTSTRAP SKILL — Replace with native Polaris taskchain in Cluster 6

# bootstrap-run chain

## Purpose

Minimal governed execution skill for early Polaris cluster sessions (Clusters 2–5). This is a temporary bridge until native Polaris taskchains are implemented in Cluster 6.

## Step traversal order

```text
01-load-cluster
02-select-child
03-execute-child
04-commit-and-update-linear
05-check-budget
06-decide-continuation
```

## Continuation rules

After step 06 evaluates the session:

- **CONTINUE**: return to step 02 within the same parent cluster session. Re-fetch the child list. Select the next lowest-numbered open child.
- **STOP (context budget)**: halt when 3 children have been completed in this session. Write checkpoint to `.taskchain_artifacts/bootstrap-run/current-state.json`. Report completed child, commit hash, next open child ID, and resume command.
- **STOP (blocked)**: follow blocker protocol. Halt immediately. Do not advance to later children.
- **CLUSTER COMPLETE**: when all children are Done, write final state and halt with "cluster complete" message.

## Context budget

Track these counters in `current-state.json` under `context_budget`:

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 3 → STOP |

Update `context_budget` after step 04 completes for each child.

## Step details

### 01-load-cluster

Read the parent Linear issue to discover children. Use `mcp2_list_issues(parentId: [parent-issue-id])` to find sub-issues.

### 02-select-child

Select the lowest-numbered open child (status is Todo or In Progress, not Done, not blocked). If no open children remain, proceed to cluster complete.

### 03-execute-child

Execute the child according to its type (implement or analyze). Follow the child's scope and done criteria.

### 04-commit-and-update-linear

Commit changes with message format: `[POL-XX] Child title`. Update Linear child status to Done.

### 05-check-budget

Check if `children_completed` ≥ 3. If so, prepare to STOP.

### 06-decide-continuation

Evaluate continuation rules:
- If budget exhausted: STOP with checkpoint
- If next child available and budget remaining: CONTINUE
- If all children Done: CLUSTER COMPLETE
- If blocked: STOP with blocker description

## Artifact update requirement

After every completed step, update `.taskchain_artifacts/bootstrap-run/current-state.json` before advancing.

## Blocker protocol

If a child is blocked, halt immediately and report the blocker with an explicit unblock condition. Do not skip blocked children.

## Important constraints

- This skill uses NO `polaris loop`, `polaris map`, or `polaris finalize` commands — those don't exist yet
- Session boundaries are soft/instructional in bootstrap mode (not structural — that comes in Cluster 6)
- Minimal: do not reproduce full EVO evo-run chain complexity
