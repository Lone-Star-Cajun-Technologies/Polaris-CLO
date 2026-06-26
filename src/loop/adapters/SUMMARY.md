# Summary: adapters

## Purpose
Execution adapter layer for dispatching bootstrap packets and worker sessions. Provides the `ExecutionAdapter` interface, terminal CLI and subagent implementations, a Foreman dispatch helper, and an adapter registry.

## Core Concepts
- `ExecutionAdapter` interface — all adapters implement `dispatch(packet, options): Promise<DispatchResult>`.
- `TerminalCliAdapter` — production adapter; launches sessions via provider CLI commands (claude, codex, copilot, etc.) using command templates from `execution.providers` in `polaris.config.json`.
- `AgentSubtaskAdapter` — in-process subagent dispatch, used in interactive/subagent contexts.
- `foreman-dispatch.ts` — `dispatchForeman()` wraps a `SetupBootstrapPacket` in a `BootstrapPacket`-compatible envelope and dispatches via `TerminalCliAdapter`; enforces checkpoint gate presence before dispatch (self-approval is structurally impossible).
- Checkpoint gate enforcement — `assertCheckpointGateEnforced()` rejects any packet where `checkpoint_gate.self_approval_prohibited !== true`, making checkpoint bypass impossible by construction.

## Architectural Role
This folder sits between packet generation (`src/skill-packet/`) and actual session launch (provider CLI or subagent runtime). It is provider-neutral: all provider-specific command templates live in config, not in adapter code.

## Key Constraints
- `dispatchForeman()` must remain provider-neutral. No provider conditionals inside adapter code.
- Checkpoint gate must be present and `self_approval_prohibited: true` on every `SetupBootstrapPacket` before dispatch.
- New adapters must implement `ExecutionAdapter` and register in `registry.ts`.

## Important Relationships
- **Upstream**: `src/cli/agent-setup.ts` (Foreman provider resolution), `src/skill-packet/generator.ts` (packet generation)
- **Downstream**: provider CLI processes or in-process subagent runtime
- **Peer**: `src/loop/` (checkpoint/telemetry uses adapters for dispatch)

## Current State
All four adapter implementations are present: `TerminalCliAdapter`, `AgentSubtaskAdapter`, `ForemanDispatch` helper, and `registry.ts`. The `dispatchForeman()` function is wired into `src/cli/init.ts` and `src/cli/adopt-command.ts` as a best-effort Foreman bootstrap launch after provider setup. Checkpoint gate enforcement is tested in `foreman-dispatch.test.ts`.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/skill-packet/types.ts`
- `src/skill-packet/generator.ts`
- `smartdocs/specs/active/foreman-bootstrap-handoff-spec.md`
