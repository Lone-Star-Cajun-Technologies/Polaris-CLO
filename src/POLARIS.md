# src

## Purpose

Primary runtime surface for Polaris: CLI entrypoints, execution loop, tracker adapters, finalize delivery, configuration, and shared types.

## What belongs here

- Runtime modules under domain folders (`cli`, `loop`, `finalize`, `config`, `tracker`, `types`, etc.)
- Domain-local tests colocated with implementation (`*.test.ts`)
- Route-local cognition files (`POLARIS.md`, `SUMMARY.md`)

## What does not belong here

- SmartDocs canonical doctrine/spec artifacts (`smartdocs/`)
- Runtime state artifacts (`.polaris/`, `.taskchain_artifacts/`)
- Ad-hoc scripts that bypass route command boundaries

## Editing rules

- Keep ownership boundaries intact: `cli` wires commands, `loop` orchestrates run state, `finalize` handles delivery, `tracker` owns tracker adapters.
- Preserve tracker-agnostic behavior in runtime flow; tracker-specific behavior stays in adapters.
- Prefer extending existing subsystems over introducing cross-route shortcuts.

## Architecture assumptions

- Polaris run flow is analyze → run/loop dispatch → closeout librarian gate → finalize delivery.
- `LocalGraph` is the normalized execution graph regardless of upstream work source.
- Canon and runtime state validation are expected to fail closed.

## Read before editing

- `docs/spec/polaris-architecture-spec.md`
- `smartdocs/specs/active/foreman-worker-architecture.md`
- `smartdocs/specs/active/closeout-librarian-spec.md`

## Related routes

- `polaris.*` (all runtime surfaces beneath `src/`)
