# Summary: test

## Purpose
Integration and acceptance test surface for Polaris runtime and adoption workflows.

## Core Concepts
- Fresh-repo tests use fixture repositories to prove installation and adoption behavior outside the Polaris checkout.
- Runtime scratch should stay out of committed or staged outputs.
- CLI-facing workflows are validated end to end when unit tests cannot cover filesystem and package boundaries.

## Architectural Role
This folder verifies cross-route behavior across CLI, adoption, workspace assets, graph setup, and artifact hygiene.

## Key Constraints
- Tests must not depend on the operator's current runtime cluster state.
- Temporary repositories and generated artifacts must be isolated and cleaned up by the test harness.

## Important Relationships
- Depends on CLI command wiring under `src/cli/`.
- Exercises artifact filtering rules from `src/finalize/`.

## Current State
The suite includes a fresh-repo adoption proof that validates `POLARIS_RULES.md`, bundled workspace assets, instruction-file migration/provenance, graph/adoption reporting, and runtime scratch filtering.

## Known Drift
Broader external tracker lifecycle proofs are still outside this folder's current coverage.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
<!-- Links to spec files, doctrine, etc. -->
