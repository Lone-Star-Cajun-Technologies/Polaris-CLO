# src/medic

## Purpose

The Medic route creates diagnostic charts, run-health consult results, and treatment-packet handoffs for Polaris runs that require diagnosis after symptoms are recorded.

## What belongs here

- `chart-id.ts` — deterministic CHART-YYYY-MM-DD-NNN generation
- `chart-schema.ts` — Medic chart validation and schema helpers
- `run-health-consult.ts` — run-health consult workflow, chart creation, consult result writing, and telemetry emission
- `route-exam.ts` — proactive route exam: reads a route's persisted health state, POLARIS.md/SUMMARY.md, owned paths, and chart history, then writes a `no-treatment-needed` diagnostic chart for the route
- `treatment-packets.ts` — treatment-packet compilation and dispatch helpers for consult follow-up work
- `chart-id.test.ts`, `chart-schema.test.ts`, `route-exam.test.ts`, `run-health-consult.test.ts` — Medic route tests

## What does not belong here

- Worker dispatch orchestration — belongs in `src/loop/`
- Final delivery logic — belongs in `src/finalize/`
- Raw run-health report storage — belongs in `src/run-health/`

## Editing rules

- Keep chart IDs deterministic and monotonic within a day.
- Run-health consults must consume the report produced by `src/run-health/`; Medic does not infer symptoms from telemetry.
- Treatment packets are follow-up artifacts only; the consult result must record the chart and packet refs used to resolve the report.
- Avoid coupling consult logic to finalize or loop internals beyond the packet contract.

## Architecture assumptions

- Medic is the only route that diagnoses run-health symptoms and records the consult outcome.
- A consult may resolve immediately (no treatment needed) or produce treatment packets for follow-up work.
- Route exams are a proactive counterpart to run-health consults: they assess a named route's persisted health state on demand (`polaris medic route-exam <route>`) and always record a `no-treatment-needed` chart, independent of the symptom-driven consult flow.
- Charts and treatment packets are durable documentation artifacts; they are not runtime state.

## Read before editing

- `src/types/result-packet.ts` — Medic packet/result and run-health symptom contracts
- `src/run-health/schema.ts` — run-health report schema
- `src/run-health/index.ts` — run-health persistence helpers
- `src/finalize/medic-gate.ts` — delivery gate that consumes Medic consult state

## Related routes

- `src/loop/` — dispatches Medic consults when run-health reports require diagnosis
- `src/finalize/` — checks the run-health Medic gate before delivery
- `smartdocs/medic/` — chart documentation and related SmartDocs output
