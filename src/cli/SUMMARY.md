# Summary: cli

## Purpose
Command-surface assembly for the `polaris` binary. This folder defines top-level CLI behavior, wires subsystem commands, and enforces consistent help/error semantics.

## Core Concepts
- `index.ts` is wiring-only: it composes command factories and shared handlers.
- Subsystem command logic belongs outside `src/cli/` (loop/map/finalize/config/docs/graph/etc.).
- Bare subsystem invocations and unknown commands must fail with actionable guidance.
- Graph commands (`build`, `query`, `impact`) are surfaced from `graph.ts` and operate on graph store/query services.
- Worker and librarian command groups exist for runtime-governed execution paths.

## Architectural Role
This route is the external operator interface for Polaris. It exposes runtime capabilities without owning business logic, preserving separation between command UX and subsystem implementation.

## Key Constraints
- Keep command registration declarative and centralized in `index.ts`.
- Do not embed subsystem business logic in CLI handlers.
- Keep output modes predictable (`--json`, dry-run, human-readable summaries).
- Preserve non-zero exits for invalid command forms.

## Important Relationships
- Depends on `src/loop/`, `src/map/`, `src/finalize/`, `src/config/`, `src/smartdocs-engine/`, `src/graph/`, and `src/skill-packet/` for command factories.
- Uses `src/loop/finalize-evidence.ts` and CLI subtask bridge setup to enforce finalize/run invariants.
- Shares version source with `package.json` through `src/cli/version.ts`.

## Current State
Top-level command groups include status, loop, map, finalize, runs, init, docs/doctrine, config, tracker, worker, graph, skill, and librarian. Graph command UX now supports build/query/impact plans, JSON output, and build coverage reporting.

## Known Drift
Older references that describe only the legacy command subset are stale and should defer to `src/cli/index.ts` command registration.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/cli/index.ts`
- `src/cli/graph.ts`
- `src/cli/librarian.ts`
