# __tests__

## Purpose

Unit tests for `src/loop/adapters/` execution adapters. Tests validate adapter dispatch behavior, fallback chain logic, quota signal handling, pre-dispatch failure classification, and router evidence propagation.

**Domain:** loop
**Route:** src/loop

## What belongs here

- `terminal-cli.test.ts` — unit tests for `TerminalCliAdapter`: covers dispatch success, pre-dispatch failure with `fallback_eligible` classification, quota signal detection, `router_evidence` attachment in `DispatchResult`, and empty `allowed_scope` blocking for `impl` and `repair` packets.

## What does not belong here

- Integration tests that require a live adapter process
- Tests for `AgentSubtaskAdapter` or `foreman-dispatch.ts` (those live alongside their source files)

## Editing rules

- Tests must not spawn real provider processes. Mock `execa` or equivalent at the module boundary.
- When testing fallback behavior, inject a `routerDecision` option with a populated `providersTried` array so the fallback order is deterministic.
- Pre-dispatch failure scenarios must assert `pre_dispatch_failure: true` and `fallback_eligible` in the returned `DispatchResult`.

## Architecture assumptions

- `TerminalCliAdapter` is tested in isolation; the test file does not depend on live config or a running Polaris loop.

## Read before editing

- [POLARIS.md](../../POLARIS.md)
- `src/loop/adapters/POLARIS.md` — adapter invariants and fallback rules
- `src/loop/adapters/terminal-cli.ts` — implementation under test

## Related routes

- `src/loop/adapters/` — source for all tested adapters
