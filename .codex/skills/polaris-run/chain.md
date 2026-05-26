# polaris-run chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime before acting. Do not infer cluster state from conversation context.

## CLI

Use repo-local Polaris only:

```
npm run polaris -- <command>
```

Never assume a globally linked `polaris` command exists.

## Step traversal order

```text
01-orient-cluster
02-dispatch-worker
03-validate-compact-result
04-synchronize-state
05-check-budget
06-evaluate-continuation
```

## Parent role

The parent agent:

- queries runtime state via `npm run polaris -- loop status`
- dispatches worker packets for each open issue
- validates compact results emitted by workers
- persists deterministic state transitions via `npm run polaris -- loop continue`

The parent does **not** manually walk issue chains, narrate reasoning about what to do next, or execute implementation work directly.

## Worker role

Workers:

- execute a single scoped packet (one issue, one task boundary)
- emit a compact result on completion
- release their lifecycle cleanly — no lingering state

## Continuation rules

After step 06 evaluates the session:

- **CONTINUE**: dispatch next worker packet. Re-query runtime state. Do not assume residual state from prior worker.
- **STOP (budget)**: halt. Emit compact checkpoint. Report: completed issue, commit hash, next open issue ID, resume command.
- **STOP (blocked)**: halt immediately with explicit unblock condition. Do not skip blocked issues.
- **CLUSTER COMPLETE**: all issues Done. Emit final compact result and halt.

## Context budget

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `issues_completed` | Issues fully Done this session | ≥ 3 → STOP |

Synchronize `context_budget` to durable state after each worker completes.

## Step details

### 01-orient-cluster

Query runtime: `npm run polaris -- loop status`

Load the cluster's open issue list from runtime state. Do not determine cluster scope from chat context.

### 02-dispatch-worker

Query runtime for the lowest-priority open issue. Dispatch a worker packet scoped to that issue. Do not execute the issue directly from the parent.

### 03-validate-compact-result

Receive the worker's compact result. Validate completeness: commit hash present, done criteria met, no open sub-tasks.

### 04-synchronize-state

Persist the state transition: `npm run polaris -- loop continue`

Commit artifact updates. Update issue status to Done. Do not advance until durable state is written.

### 05-check-budget

Check if `issues_completed` ≥ 3. If so, prepare STOP checkpoint.

### 06-evaluate-continuation

- Budget exhausted → STOP with compact checkpoint
- Next issue available, budget remaining → CONTINUE
- All issues Done → CLUSTER COMPLETE
- Blocked → STOP with blocker description

## Linked skills

- `linked-skills/caveman.md` — optional external provider doctrine (read before using Caveman)
