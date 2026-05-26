# POL-97 CLI/operator surface analysis

## Decision

Polaris should use the existing Commander-based subsystem factories as the public 1.0 CLI architecture. The current `src/cli/index.ts` switch dispatcher is drift from `src/cli/POLARIS.md`, which says the entrypoint should be thin Commander wiring and should register subsystem commands with `program.addCommand()`.

## Evidence

- `src/cli/POLARIS.md` defines Commander as the canonical CLI framework and says `src/cli/index.ts` should only register top-level commands.
- `src/loop/index.ts`, `src/map/index.ts`, and `src/finalize/index.ts` already export Commander command factories.
- `src/finalize/index.ts` already exposes `createFinalizeCommand()` and `runFinalize()`, but the public CLI does not register finalize.
- `node dist/cli/index.js --help` exits 1 with `Unknown command: --help`.
- `node dist/cli/index.js finalize --help` exits 1 with `Unknown command: finalize`.
- `node dist/cli/index.js map query src/cli/index.ts` exits 1 with `Unknown command: map`.
- `node dist/cli/index.js status --json` works because the switch CLI special-cases status.

## Architecture recommendation

Use Commander for the public entrypoint and register existing subsystem factories:

- `createLoopCommand()`
- `createMapCommand()`
- `createFinalizeCommand()`

Keep `polaris status` as a top-level alias to loop status. Add `--version` through `getVersion()`. Do not add subsystem business logic to `src/cli/index.ts`.

## Canonical 1.0 operator surface

- `polaris --help`
- `polaris --version`
- `polaris status`
- `polaris loop status`
- `polaris loop continue`
- `polaris loop continue --dry-run` once the CLI flag is backed by true non-mutating runtime semantics
- `polaris loop resume`
- `polaris loop abort`
- `polaris map query`
- `polaris map update --changed`
- `polaris map validate`
- `polaris finalize run`

`polaris run` should remain deferred or explicitly marked unavailable until it has a runtime-backed implementation.

## Finalize recommendation

Expose finalize as `polaris finalize run`. It should remain manual/operator-triggered. Loop completion should tell the operator to verify status and run finalize; it should not automatically push, create PRs, or close Linear issues without an explicit finalize command. `--dry-run` and `--skip-delivery` remain important safety valves.

## Codex plugin recommendation

Codex plugin mapping should follow the safety model:

- Safe/read-only: `polaris status`, `polaris loop status`, compact current-state summaries.
- Safe preview: `polaris loop continue --dry-run` only when it is truly non-mutating.
- Confirmed mutation: continuation only through an approval-envelope flow.
- Operator-only: `polaris finalize run` until a dedicated confirmed finalize approval flow exists.

The current Codex helper advertises direct `polaris_run` and ungated `polaris_loop_continue`; that should be removed, deferred, or clearly marked operator-only unless backed by the approved safety contract.

## Implementation children

- POL-98 — Wire Polaris public CLI through Commander and expose finalize.
- POL-99 — Normalize Polaris CLI help, errors, and operator safety text.
- POL-100 — Align Codex plugin commands with Polaris safety boundaries.
- POL-101 — Run Polaris 1.0 operator smoke test on a tiny real issue.

## Risks

- The atlas map knows `src/cli/index.ts` as Commander-based already, so implementation should update code to match local doctrine rather than changing doctrine to fit the switch CLI.
- `polaris loop continue --dry-run` is documented as desired, but existing docs note it is not yet wired as true dry-run in the CLI. Do not expose it as safe until implementation proves no state/artifact writes.
- Finalize is high-impact because it commits, pushes, creates PRs, and updates Linear. Keep it out of casual plugin surfaces.
