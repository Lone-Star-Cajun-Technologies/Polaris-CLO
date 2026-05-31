# src/cli

## Purpose

The CLI entry point for Polaris. It registers all top-level commands (`map`, `loop`, `finalize`, `docs`, `config`) using Commander.js and wires the `polaris` binary. This module contains no business logic — it delegates entirely to the subsystem command factories.

## What belongs here

- `index.ts` — binary entry point; registers subsystem commands via `addCommand()`
- `version.ts`, `version.test.ts` — version helper and test

## What does not belong here

- Command implementation logic — belongs in the respective subsystem (`src/map/`, `src/loop/`, `src/finalize/`, `src/smartdocs-engine/`, `src/config/`)
- Business logic, file I/O, or state management of any kind

## Editing rules

- To add a new top-level command, create a `create<Name>Command()` factory in the appropriate subsystem and register it with `program.addCommand()` here.
- Do not add inline `.action()` handlers in `index.ts` for anything beyond trivial cases (e.g., `config show`).
- Public help must label safe/read-only commands separately from mutating commands. Deferred 1.0 commands must be marked unavailable instead of sounding implemented.
- Unknown commands and bare subsystem commands must exit non-zero with actionable help.
- Keep `index.ts` short — it should remain a thin wiring file.
- Version string comes from `getVersion()` only — do not hardcode version strings elsewhere.

## Route model

- The binary name is `polaris` (set via `program.name("polaris")`).
- Commander.js is the only CLI framework used. Do not introduce alternatives (yargs, meow, etc.).
- All subsystem commands are registered via `addCommand()` — no positional-argument-only dispatch.

## Read before editing

- `package.json` — `"bin"` field and `"version"` field that `getVersion()` reads
- `src/map/index.ts`, `src/loop/index.ts`, `src/finalize/index.ts` — examples of command factory pattern

## Related routes

- `polaris.cli` — all files in this directory
