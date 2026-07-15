# Summary: medic

## Purpose
Diagnostic chart creation, run-health consult handling, and proactive route exams for the Medic role.

## Core Concepts
- Chart IDs are deterministic and monotonic per day (`CHART-YYYY-MM-DD-NNN`), claimed atomically via marker-file creation in `chart-id.ts`.
- A run-health consult (`run-health-consult.ts`) reads a run's `RunHealthReport`, writes a chart, and either resolves immediately or dispatches treatment-packet workers for critical/high-severity symptoms.
- A route exam (`route-exam.ts`) is a proactive, non-symptom-driven check: it reads a route's persisted health state (from `src/cognition`), POLARIS.md/SUMMARY.md content, owned paths, and chart history, then always writes a `no-treatment-needed` chart.
- Charts are durable Markdown documentation artifacts under `smartdocs/medic/charts/`, not runtime state.

## Architectural Role
Medic is the sole route that diagnoses run-health symptoms and creates diagnostic charts, whether triggered reactively by a run-health report or proactively via a route exam.

## Current State
`chart-id.ts`, `chart-schema.ts`, `run-health-consult.ts`, `route-exam.ts`, and `treatment-packets.ts` are implemented with passing tests. `src/cli/medic.ts` exposes `medic chart create`, `medic run-health-consult`, and `medic route-exam <route>`.

## Canonical References

```yaml
canonical_docs:
  - POLARIS.md
```

## Known Drift
None known.