# Step 01 — Orient Cluster

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Do not infer cluster scope, issue list, or prior progress from conversation context. Query runtime.

## Action

```
npm run polaris -- loop status
```

Never assume a globally linked `polaris` command. Always use the repo-local invocation above.

## Outputs required

- Active cluster ID
- Open issue list (ordered by priority)
- Current loop cursor position
- Budget counters from durable state

## Failure modes

| Condition | Action |
|-----------|--------|
| Runtime state missing | Halt. Report missing state. Do not reconstruct from chat. |
| Loop not initialized | Halt. Report that `polaris loop` must be initialized before running. |
| No open issues | Proceed to CLUSTER COMPLETE in step 06. |

## What this step does not do

- Does not determine cluster scope by reading Linear issues
- Does not decide what to work on next via chat reasoning
- Does not execute any implementation work
