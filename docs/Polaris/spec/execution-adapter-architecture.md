# Polaris Execution Adapter Architecture

**Status:** Proposed
**Date:** 2026-05-23
**Context:** Surfaced during POL-42 cluster — `claude -p` nesting failure exposed coupling between loop orchestration and worker execution mechanism.

---

## Problem

The current polaris-run loop assumes `claude -p` as the worker execution mechanism. This works from a terminal or CI but fails inside an active agent session (401 — nested session auth conflict). The coupling means the orchestration layer cannot be reused across execution environments.

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
  // Spawn an isolated worker for the given task prompt.
  // Resolves when the worker session completes.
  dispatch(prompt: string, opts: DispatchOptions): Promise<DispatchResult>;
}

interface DispatchOptions {
  repoRoot: string;
  worktreeIsolation?: boolean;   // give worker its own git worktree
  model?: string;                // hint to adapter; may be ignored
}

interface DispatchResult {
  status: "success" | "failure";
  exitCode?: number;
  stateSnapshot?: string;        // path to state file after completion
}
```

The loop layer calls `adapter.dispatch(prompt, opts)` and reads `current-state.json` after it resolves. It never inspects how the worker was spawned.

---

## Required Adapters

### `terminal-cli`

**Mechanism:** Shell subprocess — `$POLARIS_AGENT "prompt"` (defaults to `claude -p`)

**When to use:** Terminal execution, CI pipelines, cron, unattended runs initiated outside an agent session.

**Worktree isolation:** Sequential by default (shared worktree). Parallel requires explicit worktree flag.

**Auth:** Inherits shell environment. Works with any CLI agent that accepts a prompt as its last argument.

```bash
# terminal-cli dispatch (what scripts/polaris-run.sh does today)
claude -p "polaris-run on POL-42"
```

---

### `agent-subtask`

**Mechanism:** Agent tool dispatch from within the current agent session. Each worker runs as a sub-agent with isolated context.

**When to use:** Interactive agent sessions (Claude Code, Gemini CLI, Copilot CLI). The parent session orchestrates; each child gets a fresh context window.

**Worktree isolation:** Optional. Pass `isolation: "worktree"` to Agent tool for true Git worktree isolation per child.

**Auth:** Inherited from parent session — no separate auth needed. No nesting conflict.

```
Parent session
  └── Agent tool: "polaris-run on POL-42, child POL-45"
        └── Sub-agent (fresh context, optional worktree)
              completes → returns result to parent
  └── Agent tool: "polaris-run on POL-42, child POL-46"
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

### `connect` *(future)*

**Mechanism:** Remote worker via Connect anchor node or SSH. Polaris sends task packet; remote worker executes and pushes state back.

**When to use:** Distributed teams, air-gapped environments, long-running clusters that outlive a local session.

---

## Adapter Selection

Resolution order:

1. Explicit flag: `--adapter agent-subtask`
2. Environment variable: `POLARIS_ADAPTER=terminal-cli`
3. Config file: `polaris.config.json` → `execution.adapter`
4. **Auto-detect** (default):
   - If `POLARIS_AGENT_SESSION=true` → `agent-subtask`
   - If `CI=true` → `ci`
   - Otherwise → `terminal-cli`

Auto-detection covers the most common cases without requiring explicit configuration.

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
2. Calls `adapter.dispatch(prompt)`
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
| `connect` | Remote clone | Anchor node manages isolation |

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
  │                │ │ in Claude    │ │ node; result     │
  │ claude -p loop │ │ Code session │ │ pushed back via  │
  │                │ │              │ │ state file sync  │
  │ Fresh process  │ │ Agent tool   │ │                  │
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

> ~~"Run `claude -p "polaris-run on <child>"`"~~
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

## Open Questions

1. **How does `agent-subtask` mode handle worktree conflicts?** Two children touching the same file need sequential dispatch even in subtask mode.

2. **Does the bootstrap packet need an `adapter` field?** Would allow resumed sessions to restore the same adapter without reconfiguration.

3. **Should adapters be first-class Polaris config?** `polaris.config.json` could declare available adapters with their settings, enabling teams to define custom adapters.

4. **`connect` state sync**: Remote workers can't write to the local state file. Requires a sync protocol — out of scope for now but shapes the interface.
