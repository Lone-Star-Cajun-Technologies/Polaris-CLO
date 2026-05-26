# polaris-analyze chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime before acting. Do not infer analysis scope from conversation context.

## CLI

Use repo-local Polaris only:

```
npm run polaris -- <command>
```

Never assume a globally linked `polaris` command exists.

## Step traversal order

```text
01-orient-cluster
02-dispatch-analyze-worker
03-validate-compact-result
04-synchronize-state
05-check-budget
06-evaluate-continuation
```

## Parent role

The parent agent:

- queries runtime state via `npm run polaris -- loop status`
- dispatches analyze worker packets for each open analysis issue
- validates compact results emitted by workers
- persists deterministic state transitions

The parent does **not** manually walk issue chains, narrate reasoning about findings, or produce analysis output directly.

## Worker role

Analyze workers:

- execute a single scoped analysis packet (one issue, one analysis boundary)
- emit a compact result containing findings, commit hash, and done criteria
- release their lifecycle cleanly

## Continuation rules

After step 06 evaluates the session:

- **CONTINUE**: dispatch next analyze worker packet. Re-query runtime state first.
- **STOP (budget)**: halt. Emit compact checkpoint with next open analysis issue and resume command.
- **STOP (blocked)**: halt immediately with explicit unblock condition.
- **CLUSTER COMPLETE**: all analysis issues Done. Emit final compact result and halt.

## Context budget

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `issues_completed` | Issues fully Done this session | ≥ 3 → STOP |

Synchronize `context_budget` to durable state after each worker completes.

## Step details

### 01-orient-cluster

Query runtime: `npm run polaris -- loop status`

Load open analysis issue list from runtime state. Do not determine scope from chat context.

### 02-dispatch-analyze-worker

Query runtime for the lowest-priority open analysis issue. Dispatch an analyze worker packet scoped to that issue.

### 03-validate-compact-result

Receive the worker's compact result. Validate: findings present, done criteria met, no dangling sub-tasks.

### 04-synchronize-state

Persist the state transition: `npm run polaris -- loop continue`

Commit artifact updates. Update issue status to Done.

### 05-check-budget

Check if `issues_completed` ≥ 3. If so, prepare STOP checkpoint.

### 06-evaluate-continuation

- Budget exhausted → STOP with compact checkpoint
- Next issue available, budget remaining → CONTINUE
- All issues Done → CLUSTER COMPLETE
- Blocked → STOP with blocker description

## Linked skills

- `linked-skills/caveman.md` — optional external provider doctrine (read before using Caveman)
