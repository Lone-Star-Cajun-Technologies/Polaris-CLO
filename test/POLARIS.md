# test

## Purpose

Repository-level integration tests live here. These tests exercise Polaris behavior across command flows, generated workspaces, runtime hygiene, and fixture repositories.

## What belongs here

- Integration and acceptance tests that need broader repo setup than route-local unit tests.
- Fixture-driven proofs for adoption, packaging, runtime artifact filtering, and command workflows.

## What does not belong here

- Source implementation code.
- Route-local unit tests that belong beside the owning `src/` module.
- Generated runtime artifacts from test execution.

## Editing rules

- Keep tests deterministic and isolated from the developer's live runtime state.
- Use temporary fixture repositories for fresh-repo adoption and packaging proofs.
- Do not commit runtime scratch produced by test runs.

## Architecture assumptions

Integration tests may invoke the built CLI, npm packaging paths, and adoption flow to verify that an external repository can be initialized without leaking runtime scratch into staged output.

## Read before editing

- `src/cli/POLARIS.md`
- `src/finalize/POLARIS.md`

## Related routes

- `src/cli/`
- `src/finalize/`
