---
name: polaris-run-execution-adapter
description: Adapter boundary for dispatching Polaris child worker sessions without coupling orchestration to a specific agent runtime.
---

# Execution Adapter Boundary

Polaris orchestration is adapter-agnostic. The parent session selects the next child and uses `polaris loop dispatch` as the dispatch trigger for the configured adapter. The worker session performs implementation and returns only compact state: child ID, status, commit hash, validation summary, and next action. After that return, the parent may run `polaris loop continue` as the post-child checkpoint.

The adapter boundary is the token boundary. Parent/orchestrator context must not accumulate child implementation transcripts.

## Adapter Modes

| Mode | Use | Dispatch |
|---|---|---|
| `agent-subtask` | Interactive agent sessions **only when `allowNativeSubagent: true`** | Use the host agent's subtask/agent dispatch capability. **FORBIDDEN when `providerPolicy.*.allowNativeSubagent: false`** — do not search for, invoke, or attempt any native subagent tool. |
| `terminal-cli` | Terminal, cron, CI wrapper; **required when `allowNativeSubagent: false`** | Use `scripts/polaris-run.sh` or equivalent shell subprocess with an explicitly configured CLI worker. |
| `ci` | Remote CI workers | Dispatch a CI job and read the state artifact after completion. |

> **Prohibition**: When `polaris.config.json` sets `providerPolicy.worker.allowNativeSubagent: false` (or `providerPolicy.orchestrator.allowNativeSubagent: false`), the `agent-subtask` mode is unconditionally forbidden. The Foreman must not search for, load, or invoke any native subagent or Agent tool. The only legal dispatch path is `terminal-cli`.

## Contract

1. Parent reads `.taskchain_artifacts/polaris-run/current-state.json`.
2. Parent runs `polaris loop dispatch`, which dispatches the next child through the selected adapter.
3. Worker updates current-state and telemetry.
4. Parent reads current-state after worker completion.
5. Parent does not ingest worker transcript content.
6. Parent runs `polaris loop continue` only after the worker has returned.
