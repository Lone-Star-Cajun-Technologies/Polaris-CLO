# Summary: __tests__

## Purpose
Unit tests for `src/loop/adapters/` execution adapters. Validates dispatch success, pre-dispatch failure classification, fallback chain logic, quota signal detection, and router evidence propagation.

## Core Concepts
- `terminal-cli.test.ts` tests `TerminalCliAdapter` in isolation (mocked provider process).
- Pre-dispatch failure assertions check `pre_dispatch_failure: true` and `fallback_eligible` in returned `DispatchResult`.
- Router evidence (`router_evidence`) is validated as attached to dispatch results for telemetry correlation.

## Architectural Role
Provides regression coverage for adapter fallback and failure classification logic introduced by the Worker Router integration (POL-468).

## Key Constraints
- Tests do not spawn real provider processes.
- Fallback behavior tests inject `routerDecision` with a deterministic `providersTried` array.

## Current State
`terminal-cli.test.ts` covers dispatch success, pre-dispatch failure, quota signal detection, `router_evidence` attachment, and empty `allowed_scope` blocking for `impl` and `repair` packets. All tests pass under the mocked adapter harness.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/loop/adapters/POLARIS.md`
