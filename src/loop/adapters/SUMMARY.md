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
- `dispatchForeman()` remains provider-neutral. No provider conditionals inside adapter code.
- The checkpoint gate is present with `self_approval_prohibited: true` on every `SetupBootstrapPacket` before dispatch.
- New adapters implement `ExecutionAdapter` and register in `registry.ts`.

## Important Relationships
- **Upstream**: `src/cli/agent-setup.ts` (Foreman provider resolution), `src/skill-packet/generator.ts` (packet generation)
- **Downstream**: provider CLI processes or in-process subagent runtime
- **Peer**: `src/loop/` (checkpoint/telemetry uses adapters for dispatch)

## Current State
All adapter components are present: `TerminalCliAdapter` and `AgentSubtaskAdapter` (adapter implementations), `ForemanDispatch` (dispatch helper), and `registry.ts` (adapter registry). The `dispatchForeman()` function is wired into `src/cli/init.ts` and `src/cli/adopt-command.ts` as a best-effort Foreman bootstrap launch after provider setup. Checkpoint gate enforcement is tested in `foreman-dispatch.test.ts`. Router fallback is now integrated: `TerminalCliAdapter` accepts a `routerDecision` in `DispatchOptions`, builds a fallback chain from `providersTried`, and returns `pre_dispatch_failure: true` with `fallback_eligible: true` when a provider fails before the worker starts. `AgentSubtaskAdapter` emits the same `pre_dispatch_failure` signal on invocation errors. Once `worker-acknowledged` is received, `fallback_eligible` is set to `false` for all remaining results. Router evidence (`router_evidence`) is attached to every `DispatchResult` for telemetry correlation. `TerminalCliAdapter` also rejects `impl` and `repair` packets with an empty `allowed_scope` at dispatch, returning `pre_dispatch_failure: true` and `fallback_eligible: false` so the Foreman can escalate instead of launching a scopeless worker.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/skill-packet/types.ts`
- `src/skill-packet/generator.ts`
- `smartdocs/specs/active/foreman-bootstrap-handoff-spec.md`
- `smartdocs/specs/active/worker-router-architecture.md`
