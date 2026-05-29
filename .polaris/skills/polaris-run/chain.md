---
name: polaris-run-chain
description: Route map for polaris-run — step order, continuation rules, Polaris runtime integration, and artifact update requirements.
---

# polaris-run chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer cluster scope or progress from conversation context.

## Thin-Parent Orchestration

This skill operates under a **thin-parent** model. The agent running this `chain.md` is an orchestrator, not an implementer.

**Core principles:**
- **The orchestrator does not write code.** All implementation is delegated to workers via `polaris loop dispatch`.
- **The orchestrator does not narrate implementation details.** Its communication should be concise and focused on the orchestration state (dispatching, checkpointing, blocked, complete).
- **The orchestrator does not reason about the repository.** All repository-level cognition belongs to the worker.

### Narration Suppression

To enforce the thin-parent model, the orchestrator's narration is strictly suppressed.

**Allowed narration:**
- Announcing the start of a run.
- Announcing the dispatch of a child.
- Announcing the completion of a child and the next step (continue, finalize, or stop).
- Announcing a blocker.

**Forbidden narration:**
- Summarizing code changes made by a worker.
- Explaining implementation details.
- Speculating on architecture or design.
- Any form of "thinking out loud" about the repository content.

The `polaris loop run` command may provide terse, single-line status updates for headless/SSH execution. The agent should not add any extra narration around these.

## CLI

Always use the repo-local Polaris CLI:

```
npm run polaris -- <command>
```

Never assume a globally linked `polaris` command exists.

## Step traversal order

```text
01-orient-cluster
02-prepare-branch
03-select-child
04-execute-child              ← worker/adapter-owned execution phase
05-validate-child             ← worker-owned validation phase
06-commit-and-update-linear   ← worker-return validation and completion recording
07-decide-continuation   → DISPATCH boundary | CHECKPOINT after worker return | STOP (blocked/all-done) | DELIVER: go to 08
08-final-delivery        ← reached when all children Done and delivery requested
```

## Continuation rules

After step 07 evaluates the session:

- **DISPATCH boundary (next-child)**: when another child is eligible, run `npm run polaris -- loop dispatch` or invoke the execution adapter directly. **The runtime enforces dispatch boundaries. Parent/orchestrator inline implementation is forbidden.** State updates occur only at CHECKPOINT boundaries, not between steps.
- **CHECKPOINT (worker-returned)**: after the dispatched worker returns compact state, run `npm run polaris -- loop continue` to checkpoint state, emit telemetry, and generate or refresh the bootstrap packet. Worker transcripts must not merge back into parent context. This is the only boundary where state updates occur.
- **STOP (blocked)**: halt immediately on blocker. Report unblock condition.
- **STOP (all-done, awaiting delivery)**: all children Done but delivery not yet requested. Report branch and last commit. Provide delivery command: `Use polaris-run on <PARENT-ID>. Finalize delivery.`
- **DELIVER**: proceed to step 08 only when all children are Done and the user explicitly requests delivery in this session invocation.

## Dispatch boundary enforcement (runtime-owned)

**The runtime enforces dispatch boundaries. Parent/orchestrator inline implementation is forbidden.**

This is not advisory. The runtime will hard-fail with `process.exit(1)` on violations.

### Allowed transition sequence (only legal path)

```
child selected
  → polaris loop dispatch        (sets dispatch_boundary.dispatch_epoch++)
  → worker runs externally       (adapter dispatch, NOT inline)
  → worker returns CompactReturn
  → polaris loop continue        (checks dispatch_epoch > continue_epoch, then sets continue_epoch++)
  → next child (repeat) or cluster-complete
```

### Hard failures (illegal transitions)

| Attempt | Runtime response |
|---|---|
| `polaris loop continue` without prior dispatch | `exit(1)` + `dispatch-required` telemetry event |
| `polaris loop dispatch` with `active_child` already set | `exit(1)` + `invalid-inline-attempt` telemetry event |
| Parent completing child without dispatch record | `exit(1)` + `illegal-state-transition` telemetry event |
| `selected → completed` (no dispatch in path) | Hard failure — never allowed |
| `selected → checkpointed` (no dispatch in path) | Hard failure — never allowed |

### No inline fallbacks

There are no soft warnings. There are no inline fallback execution paths. There is no "continue means dispatch" behavior. The only legal transition from child selected to child execution is `polaris loop dispatch`.

Interactive-agent mode uses an agent/subtask adapter, not shell nesting. Terminal/CI mode may use `scripts/polaris-run.sh` as the `terminal-cli` adapter.

## Polaris runtime integration

polaris-run augments the evo-run pattern with three Polaris-specific calls:

| Step | Polaris call | Purpose |
|---|---|---|
| 07 | `npm run polaris -- loop dispatch` | Dispatch exactly one selected child through the configured execution adapter; this starts child execution |
| 07 | `npm run polaris -- loop continue` | Post-child checkpoint: emit checkpoint telemetry, update state at checkpoint boundary, generate bootstrap packet, enforce boundary. This is the only time state updates occur between DISPATCH boundaries. |
| 08 | `npm run polaris -- finalize` | Push branch, open PR, append JSONL closeout events, archive run snapshot |

`npm run polaris -- loop dispatch` is the dispatch command. It selects the configured execution adapter and sends one child worker prompt across the parent/worker boundary.

`npm run polaris -- loop continue` is post-child only. It reads `.polaris/session-type` and `current-state.json` after the worker has returned, runs the boundary check, checkpoints state, and emits the bootstrap packet. State updates occur only at this explicit checkpoint boundary. The skill reads the packet's compact output to determine whether to halt, deliver, or begin another explicit dispatch phase.

## Context budget

Track in `.taskchain_artifacts/polaris-run/current-state.json` under `context_budget`. Update after each child.

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | ≥ 1 → adapter handoff or STOP |
| `files_touched_total` | Total files changed this session | > 50 → STOP (safety) |
| `last_child_files_touched` | Files changed by last child | > 20 → STOP (safety) |

## Run ID format

Format: `polaris-run-<slug>-<date>-<seq>`
- `<slug>`: 2–4 lowercase hyphenated words from the cluster title. No Linear IDs.
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `polaris-run-loop-boundary-2026-05-23-001`

Resumed sessions generate a new `run_id`. Record the prior in `related_run_id`.

## Telemetry enforcement

Telemetry file: `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Emitted by | Step |
|---|---|---|
| `run-start` | agent | 01 — before any Linear access |
| `child-dispatched` | `npm run polaris -- loop dispatch` | 07 — when one child is accepted by the execution adapter |
| `child-complete` | parent runtime | 07 — after worker return validation and completion recording |
| `loop-checkpoint` | `npm run polaris -- loop continue` | 07 — after each child |
| `analyze-impl-boundary-enforced` | `npm run polaris -- loop continue` | 07 — blocker/state-repair boundary event only |
| `loop-aborted` | `npm run polaris -- loop abort` | any blocker halt |
| `pr-opened` | `npm run polaris -- finalize` | 08 |
| `run-complete` | `npm run polaris -- finalize` | 08 |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Artifact authority

`.taskchain_artifacts/polaris-run/current-state.json` is the sole authoritative live state surface.

- Update only at explicit checkpoint boundaries via `npm run polaris -- loop continue` after worker returns, or when DISPATCH boundaries mandate bootstrapping.
- Parent agents must not update state inline between steps.
- If the checkpoint fails: stop and report the persistence failure.

## Machine snapshot

- **Path**: `.taskchain_artifacts/polaris-run/current-state.json`
- **Update requirement**: only at checkpoint boundaries (via `npm run polaris -- loop continue`)
- **Purpose**: fast agent resume without replaying JSONL or markdown history

## Completion rule

Do not report workflow completion until `.taskchain_artifacts/polaris-run/current-state.json` has `status: complete`.

## Linked-skill invocation boundaries

| Skill | Allowed steps | Condition |
|---|---|---|
| repo-analysis | 01, 02, 03, 04 | targeted lookup only; conditional on provider availability |
| execution-adapter | 07 | required when a completed child has a next open child |

## Execution reporting

At checkpoint boundaries (worker returns), emit a checkpoint report:

```text
**[step-name]** done | blocked | needs-input
Changed: <files / artifacts / branches / issues> or none
Validated: <commands / checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full:
- Generated code
- Safety warnings
- Blocker descriptions
- Acceptance-criteria gap explanations
- Irreversible-action confirmations
