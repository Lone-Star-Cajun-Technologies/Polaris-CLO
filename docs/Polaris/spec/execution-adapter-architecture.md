# Polaris Execution Adapter Architecture

**Status:** Active
**Date:** 2026-05-23
**Context:** Surfaced during POL-42 cluster — nested CLI worker failure exposed coupling between loop orchestration and worker execution mechanism.

---

## Problem

The current polaris-run loop can assume a terminal CLI worker as the execution mechanism. This works from a terminal or CI but fails inside an active agent session when it nests another agent CLI. The coupling means the orchestration layer cannot be reused across execution environments.

---

## Core Separation

```
┌─────────────────────────────────────────┐
│           Polaris Loop Layer            │
│                                         │
│  continuation · checkpoints · ordering  │
│  cluster state · telemetry · artifacts  │
│                                         │
│  knows: what to run next                │
│  does NOT know: how to spawn a worker   │
└──────────────────┬──────────────────────┘
                   │  dispatch(task, opts)
                   ▼
┌─────────────────────────────────────────┐
│         Execution Adapter Layer         │
│                                         │
│  terminal-cli · agent-subtask · ci      │
│  future: connect / anchor / remote      │
│                                         │
│  knows: how to spawn an isolated worker │
│  does NOT know: what the worker does    │
└─────────────────────────────────────────┘
```

Polaris owns **orchestration**. The adapter owns **worker spawning**.

---

## Execution Adapter Interface

Every adapter must satisfy:

```typescript
interface ExecutionAdapter {
  // Spawn one isolated worker for one selected child.
  // Resolves after the worker updates current-state and telemetry.
  dispatch(packet: CompactBootstrapState, opts: DispatchOptions): Promise<DispatchResult>;
}

interface DispatchOptions {
  repoRoot: string;
  worktreeIsolation?: boolean;   // give worker its own git worktree
  providerHint?: string;         // hint to adapter; may be ignored
}

interface DispatchResult {
  status: "success" | "failure";
  exitCode?: number;
  child_id: string;
  commit_hash?: string;
  validation_summary?: string;
  next_action?: string;
  stateSnapshot?: string;        // path to state file after completion
}
```

The loop layer calls `adapter.dispatch(packet, opts)` and reads `current-state.json` after it resolves. It never inspects how the worker was spawned. The parent receives only the compact `DispatchResult`, never the worker transcript.

### Compact Bootstrap State

The bootstrap packet carries a compact handoff object:

```typescript
interface CompactBootstrapState {
  run_id: string;
  cluster_id: string;
  child_id: string | null;
  state_file: string;
  telemetry_file: string;
  current_state_sha: string;
  branch: string;
  return_summary_contract: [
    "child_id",
    "status",
    "commit_hash",
    "validation_summary",
    "next_action"
  ];
}
```

This is the only payload the parent should pass to the worker. The worker may inspect repo files as needed, but the parent must not shuttle prior child transcripts into the next child.

---

## Required Adapters

### `terminal-cli`

**Mechanism:** Shell subprocess — `$POLARIS_AGENT "prompt"` or equivalent configured command.

**When to use:** Terminal execution, cron, unattended runs initiated outside an agent session.

**Worktree isolation:** Sequential by default (shared worktree). Parallel requires explicit worktree flag.

**Auth:** Inherits shell environment. Works with a configured CLI worker command that accepts compact bootstrap state or a prompt as its final argument.

```bash
# terminal-cli dispatch (what scripts/polaris-run.sh does today)
scripts/polaris-run.sh POL-42 --agent "<configured cli worker>"
```

Any named CLI worker may be configured for local terminal use, but no specific agent CLI is the conceptual Polaris runtime and no nested agent CLI may be used by default inside an active agent session.

---

### `agent-subtask`

**Mechanism:** Native subtask/subagent dispatch from within the current agent session. Each worker runs with isolated context in the same provider runtime.

**When to use:** Interactive agent sessions. The parent session orchestrates; each child gets a fresh context window.

**Worktree isolation:** Optional. Pass `isolation: "worktree"` to Agent tool for true Git worktree isolation per child.

**Auth:** Inherited from parent session — no separate auth needed. No nesting conflict.

**Provider rule:** Providers implement this adapter with their own native mechanism. Polaris does not hardcode Claude, Codex, or any other agent. It only emits the contract and compact packet.

```
Parent session
  └── Native subtask: compact_bootstrap_state(child POL-45)
        └── Sub-agent (fresh context, optional worktree)
              completes → returns result to parent
  └── Native subtask: compact_bootstrap_state(child POL-46)
        └── Sub-agent (fresh context)
              ...
```

---

### `ci`

**Mechanism:** CI job dispatch — GitHub Actions `workflow_dispatch`, CircleCI pipeline trigger, etc.

**When to use:** Fully automated pipelines where no human session is present.

**Worktree isolation:** Each CI job gets a fresh checkout by default.

**Auth:** CI secrets/tokens injected via environment.

---

### `ssh` / `remote-worker` *(future)*

**Mechanism:** Remote worker via SSH, Connect anchor node, or another remote worker channel. Polaris sends compact bootstrap state; the remote worker executes and pushes state back.

**When to use:** Distributed teams, air-gapped environments, long-running clusters that outlive a local session.

---

## Adapter Selection

Resolution order:

1. Native same-agent subtask/subagent dispatch.
2. Terminal CLI worker dispatch.
3. CI/SSH/remote worker dispatch.
4. Cross-agent fallback only when explicitly configured or when token budget is low.

Explicit `--adapter` or `polaris.config.json -> execution.adapter` may pin an adapter. Cross-agent fallback is denied unless `execution.allowCrossAgentFallback` or an equivalent emergency token-budget signal is set.

When Polaris detects an active agent session but no native subtask mechanism, it must fail gracefully into a compact external-worker handoff. It must not shell out to a nested agent CLI by default.

---

## State and Telemetry Across Adapters

The state file and telemetry are **adapter-agnostic**. Both adapters read and write the same files.

```
.taskchain_artifacts/polaris-run/
  current-state.json          ← authoritative live state (all adapters)
  runs/<run-id>/telemetry.jsonl  ← append-only event log (all adapters)
```

The orchestration layer:
1. Reads `current-state.json` before dispatch to confirm pre-conditions
2. Calls `adapter.dispatch(compact_bootstrap_state)`
3. Reads `current-state.json` after dispatch resolves to determine next action
4. Never assumes the worker writes to any other surface

Workers are responsible for updating `current-state.json` and appending telemetry. The adapter does not mediate this — it only provides the execution environment.

---

## Worktree Isolation Behavior

| Adapter | Default | With isolation flag |
|---|---|---|
| `terminal-cli` | Shared worktree, sequential | Caller creates worktree; passes `--repo-root` to worker |
| `agent-subtask` | Shared worktree | `isolation: "worktree"` in Agent tool call creates Git worktree automatically |
| `ci` | Fresh checkout per job | N/A — CI provides isolation natively |
| `ssh` / `remote-worker` | Remote clone | Remote worker manages isolation |

For most polaris-run clusters, sequential shared-worktree execution is correct. Parallel worktree isolation is reserved for explicitly independent children.

---

## How the Three Runtimes Share One Orchestration Layer

```
                    ┌────────────────────┐
                    │  Polaris Loop Core │
                    │  (adapter-agnostic)│
                    └────────┬───────────┘
                             │
           ┌─────────────────┼──────────────────┐
           ▼                 ▼                  ▼
  ┌────────────────┐ ┌──────────────┐ ┌─────────────────┐
  │  terminal-cli  │ │agent-subtask │ │  connect/future  │
  │                │ │              │ │                  │
  │ User opens     │ │ User says    │ │ Polaris sends    │
  │ terminal, runs │ │ "polaris-run │ │ task packet to   │
  │ polaris-run.sh │ │  on POL-42"  │ │ remote anchor    │
  │                │ │ in agent     │ │ node; result     │
  │ CLI worker     │ │ Agent session│ │ pushed back via  │
  │                │ │              │ │ state file sync  │
  │ Fresh process  │ │ Native task  │ │                  │
  │ per child      │ │ per child    │ │ Fresh remote     │
  └────────────────┘ └──────────────┘ └─────────────────┘
```

In all three cases:
- The orchestration logic (step ordering, child selection, telemetry, state) is identical
- Only the dispatch call differs
- `current-state.json` is the handoff surface between orchestrator and worker

---

## Minimal Taskchain Changes Required

The chains themselves change minimally. The key changes are:

**1. `chain.md`** — Replace execution-specific language with adapter-neutral language:

> ~~"Run a named agent CLI for `<child>`"~~
> "Dispatch next child via configured execution adapter"

**2. Step 07 (`07-decide-continuation.md`)** — Remove hardcoded STOP-after-one-child rule. Route to adapter dispatch instead of halting.

**3. New: `execution-adapter.md`** — Linked skill that describes how to invoke the adapter for the current runtime (auto-detected or configured). Each chain step that dispatches work calls this linked skill.

**4. `polaris loop continue`** — Extend to emit the adapter mode in the bootstrap packet so resumed sessions use the same adapter.

**5. `scripts/polaris-run.sh`** — Retained as the `terminal-cli` adapter implementation. No changes needed; already correct for its mode.

---

## What Does NOT Change

- `current-state.json` schema
- Telemetry event format and JSONL append-only contract
- Step ordering within chains
- Acceptance criteria evaluation
- Linear integration
- `polaris map update --changed` and `polaris finalize` calls
- The STOP (blocked) / DELIVER decision logic

The orchestration layer is stable. Only the dispatch mechanism is parameterized.

---

## Session Context Contract (Token Budget Design)

This is the primary design constraint. Violating it causes token burn to compound across the loop.

### Parent / Orchestrator Session — stays lean for the entire loop

The parent session must never accumulate:
- Child implementation details
- Test output or lint output
- File diffs or code written by workers
- Full Linear issue bodies
- Sub-agent conversation transcripts

The parent session only ever holds:
- The current `current-state.json` snapshot (small, structured)
- The worker's return summary for the just-completed child
- Loop control logic (next child selection, stop/continue decision)

**If the parent session grows, the design is wrong.**

### Worker Session — does all heavy work in isolation

Each worker session:
- Receives a compact bootstrap prompt: child ID + path to `current-state.json`
- Reads what it needs (issue body, source files, atlas) independently
- Implements, validates, commits, updates state file, emits telemetry
- Returns ONE small summary to the parent: `{child_id, status, commit, validation}`
- Its full context is discarded when it exits — this is intentional

The worker's context window can be large. That cost is bounded per child and does not compound.

### Loop Completion Summary

When all children are done, the worker for the final child (or a dedicated summary step) produces a small loop summary:

```json
{
  "cluster_id": "POL-42",
  "children_completed": ["POL-43", "POL-44", "POL-45"],
  "final_commit": "abc1234",
  "status": "all-children-complete",
  "next_action": "polaris-run on POL-42 --deliver"
}
```

This is what the parent session reads. Not transcripts. Not diffs.

### Contract Enforcement

The execution adapter enforces this boundary structurally:

- **`terminal-cli`**: OS process boundary — worker transcript is printed to terminal, not fed back to parent session. Parent only reads `current-state.json` after process exits.
- **`agent-subtask`**: Agent tool's return value must be the small summary only. The sub-agent must be prompted to return a compact result, not a full report. Parent does not read the sub-agent's full output.
- **`ci`**: Job output goes to CI logs. Parent reads state file from artifact store.

### Why This Matters

In a 10-child cluster, if the parent accumulates each child's full implementation context:
- Session 1: baseline
- Session 10: 10× context, likely approaching limits, quality degrading

With the contract enforced:
- Every session tick: ~same small context
- Cost per child is bounded by the worker session, not compounding in the parent

---

## Open Questions

1. **How does `agent-subtask` mode handle worktree conflicts?** Two children touching the same file need sequential dispatch even in subtask mode.

2. **Does the bootstrap packet need an `adapter` field?** Would allow resumed sessions to restore the same adapter without reconfiguration.

3. **Should adapters be first-class Polaris config?** `polaris.config.json` could declare available adapters with their settings, enabling teams to define custom adapters.

4. **`connect` state sync**: Remote workers can't write to the local state file. Requires a sync protocol — out of scope for now but shapes the interface.
