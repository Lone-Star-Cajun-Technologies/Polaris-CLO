# src/cli

## Purpose

The CLI entry point for Polaris. It wires the `polaris` binary, registers all top-level commands via Commander.js, and delegates behavior to subsystem command factories.

## What belongs here

- `index.ts` — binary entry point; registers subsystem commands via `addCommand()`
- `graph.ts` — `polaris graph build|query|impact` command group and output formatting
- `librarian.ts` — closeout librarian packet command surface
- config command wiring — `polaris config show|doctor` and related read-only reporting
- `medic.ts` — `polaris medic chart create` command; scaffolds Medic diagnostic charts
- `worker.ts` — worker-owned commit enforcement command factory
- `version.ts`, `version.test.ts` — version helper and test

## What does not belong here

- Command implementation logic — belongs in the respective subsystem (`src/map/`, `src/loop/`, `src/finalize/`, `src/smartdocs-engine/`, `src/config/`)
- Business logic, file I/O, or state management of any kind

## Editing rules

- To add a new top-level command, create a `create<Name>Command()` factory in the appropriate subsystem and register it with `program.addCommand()` here.
- Do not add inline `.action()` handlers in `index.ts` for anything beyond trivial cases (e.g., `config show`).
- Public help must label safe/read-only commands separately from mutating commands. Deferred 1.0 commands must be marked unavailable instead of sounding implemented.
- Unknown commands and bare subsystem commands must exit non-zero with actionable help.
- `welfare-check` is a safe/read-only top-level command wired from `src/map/welfare.ts`; it exits non-zero when route health review is required.
- `config doctor` is read-only and should describe install, provider, tracker, and artifact readiness without mutating state.
- `librarian packet` is a packet generator only; the dispatch/execution of closeout work lives outside the CLI surface.
- Keep `index.ts` short — it should remain a thin wiring file.
- Version string comes from `getVersion()` only — do not hardcode version strings elsewhere.

## Route model

- The binary name is `polaris` (set via `program.name("polaris")`).
- Commander.js is the only CLI framework used. Do not introduce alternatives (yargs, meow, etc.).
- All subsystem commands are registered via `addCommand()` — no positional-argument-only dispatch.

## Read before editing

- `package.json` — `"bin"` field and `"version"` field that `getVersion()` reads
- `src/map/index.ts`, `src/loop/index.ts`, `src/finalize/index.ts` — command factory pattern examples
- `src/graph/` — graph pipeline/query/store behavior invoked by `graph.ts`

## Related routes

- `polaris.cli` — all files in this directory
