# src/loop/adapters

## Purpose

The adapters subfolder provides execution adapter implementations for dispatching bootstrap packets and worker sessions. It defines the `ExecutionAdapter` interface, the `TerminalCliAdapter` (terminal CLI dispatch), the `AgentSubtaskAdapter` (in-process subagent dispatch), and the `ForemanDispatch` helper that launches a Foreman with a setup-bootstrap packet.

**Domain:** loop
**Route:** src/loop

## What belongs here

- `types.ts` — `ExecutionAdapter` interface, `BootstrapPacket`, `DispatchResult`, `DispatchOptions`, `WorkerSummary` types
- `terminal-cli.ts` — `TerminalCliAdapter`: dispatches sessions via terminal CLI commands (e.g. `claude`, `codex`, `copilot`)
- `agent-subtask.ts` — `AgentSubtaskAdapter`: dispatches sessions as in-process subagents
- `foreman-dispatch.ts` — `dispatchForeman()`: wraps a `SetupBootstrapPacket` and launches the Foreman via `TerminalCliAdapter`; enforces checkpoint gate presence before dispatch
- `registry.ts` — `createAdapter()`: factory that selects adapter implementation from execution config
- `index.ts` — re-exports all public adapter types and implementations
- `worker-instructions.ts` — shared worker instruction generation utilities
- `*.test.ts` — unit tests for each adapter

## What does not belong here

- Provider-specific command templates — those live in `polaris.config.json` under `execution.providers`
- Business logic for loop checkpointing or telemetry — belongs in `src/loop/`
- Packet generation — belongs in `src/skill-packet/`

## Editing rules

- `dispatchForeman()` must remain provider-neutral. Provider-specific launch behavior stays in adapter implementations (e.g., `TerminalCliAdapter`). Do not add provider conditionals here.
- `assertCheckpointGateEnforced()` is a safety pre-condition: a `SetupBootstrapPacket` without `checkpoint_gate.self_approval_prohibited === true` must be rejected at dispatch time, not silently passed.
- Do not add new adapter implementations without a corresponding registry entry in `registry.ts`.
- Adapters must implement the `ExecutionAdapter` interface from `types.ts`.

## Architecture assumptions

- `TerminalCliAdapter` is the default adapter for all production dispatch paths.
- `AgentSubtaskAdapter` is used only when running in an interactive/subagent context.
- `foreman-dispatch.ts` wraps `SetupBootstrapPacket` into a `BootstrapPacket`-compatible shape so existing adapters can dispatch it without modification.
- The checkpoint gate (`checkpoint_gate.self_approval_prohibited: true`) is a "by construction" invariant — `generateSetupBootstrapPacket()` always sets it; dispatch rejects packets that lack it.

## Read before editing

- [POLARIS.md](../POLARIS.md)
- `src/skill-packet/types.ts` — `SetupBootstrapPacket`, `CheckpointGate`
- `src/skill-packet/generator.ts` — `generateSetupBootstrapPacket()`
- `src/config/schema.ts` — `ExecutionConfig`
- `smartdocs/specs/active/worker-router-architecture.md` — future provider selection, fallback boundaries, and pre-dispatch failure classification

## Architecture notes

- Adapters remain provider-neutral and execution-only. Provider selection and fallback ordering are owned by the Worker Router; adapters report whether a dispatch failed before any worker started (`pre_dispatch_failure`) so the router can consider the next candidate.

## Related routes

- `polaris.loop` — all files in this directory
- `src/skill-packet/` — packet generation
- `src/cli/agent-setup.ts` — Foreman provider resolution (upstream of `dispatchForeman`)
