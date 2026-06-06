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
| `agent-subtask` | Interactive agent sessions (requires `allowNativeSubagent: true`) | Use the host agent's subtask/agent dispatch capability. |
| `terminal-cli` | Terminal, cron, CI wrapper; **required when the active polaris-run dispatch role sets `allowNativeSubagent: false`** | Use `scripts/polaris-run.sh` or equivalent shell subprocess with an explicitly configured CLI worker. |

> **Prohibition (polaris-run worker and orchestrator dispatch only)**
>
> - When the active polaris-run dispatch role sets `execution.providerPolicy.worker.allowNativeSubagent: false` or `execution.providerPolicy.orchestrator.allowNativeSubagent: false`, the `agent-subtask` mode is forbidden for that role.
> - This applies across host CLIs and providers: Claude, Codex, Copilot, and other agent runtimes all expose native subagent or parallel-task mechanisms that are disallowed under this flag for worker/orchestrator dispatch.
> - Other roles (e.g., `analyst`) may independently permit native subagents via their own `allowNativeSubagent` setting.
> - The Foreman must not search for, load, or invoke any native subagent mechanism when dispatching workers.
> - The current runtime adapter registry supports only `terminal-cli` and `agent-subtask`, so when the active role disallows native subagents the legal dispatch path is `terminal-cli`.

## Contract

1. Parent reads `.taskchain_artifacts/polaris-run/current-state.json`.
2. Parent runs `polaris loop dispatch`, which dispatches the next child through the selected adapter.
3. Worker updates current-state and telemetry.
4. Parent reads current-state after worker completion.
5. Parent does not ingest worker transcript content.
6. Parent runs `polaris loop continue` only after the worker has returned.
