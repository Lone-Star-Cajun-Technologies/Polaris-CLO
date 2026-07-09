# types

## Purpose

Shared TypeScript type definitions for Polaris runtime contracts. This folder contains
interfaces, union types, and type guards that cross route boundaries — primarily for
worker result packets, run-health symptom contracts, Medic dispatch, and tracker/tool adapter surfaces.

## What belongs here

- `result-packet.ts` — `ResultPacket`, `SuccessResultPacket`, `FailedResultPacket`, `WorkerRunHealthSymptom`, `MedicPacket`, `MedicResult`, `MedicRunHealthPacket`, `MedicRunHealthResult`, `MedicChart`, `MedicTreatmentPacket` types and `isFailedResultPacket` type guard
- `runtime-state.ts` — runtime execution state shape used across loop and finalize
- `linear.ts` — Linear tracker adapter types
- `tool-server-linear.d.ts` — ambient declarations for the Linear tool-server integration
- `sol-evidence.ts` — SOL normalized read model: `SolEvidence`, `SolGroupingKeys`, `SolRunEvidence`, `SolChildEvidence`, `SolForemanEvidence`, `SolWorkerEvidence`, `SolRouterEvidence`, `SolQcEvidence`, `SolValidationEvidence`, `SolTokenEvidence`, `SolInterventionEvidence`, and `EvidenceAvailability` sentinel; all inputs are optional unless explicitly marked required
- `sol-score.ts` — SOL scoring output model: `SolDimensionScore`, `SolForemanScoreReport`, `SolWorkerScoreReport`, `SolScoreReport`, and `SolScoreConfidence`; scores are 0.0–1.0 where 1.0 = optimal; skipped dimensions carry a `skipped_reason` instead of a null score

## What does not belong here

- Domain-specific types with a clear owning route — those belong beside their module (e.g., `src/graph/`, `src/medic/`)
- Runtime implementations or logic — types only, no runtime behavior

## Editing rules

- `ResultPacket` discriminated union is authoritative for worker→Foreman→Medic communication. Do not widen it without updating all consumers.
- `MedicPacket`, `MedicRunHealthPacket`, `MedicResult`, and `MedicRunHealthResult` are the dispatch and return contracts for the Medic role. Keep aligned with `.polaris/skills/polaris-medic/SKILL.md`.
- Type guards belong here only when the type lives here.
- SOL types (`sol-evidence.ts`, `sol-score.ts`) are the authoritative schema for the Self-Optimization Loop evidence and scoring contracts. Do not add SOL-specific runtime logic here; keep these files types-only.
- `EvidenceAvailability` sentinel (`"available" | "unavailable" | "future"`) marks optional SOL evidence fields as present, explicitly absent, or pending a future upstream source.

## Related routes

- `src/loop/` — consumes `ResultPacket` for child result handling
- `src/medic/` — consumes `MedicPacket`/`MedicResult` and run-health consult types for chart creation
- `src/autoresearch/` — consumes `SolEvidence` and `SolScoreReport` types for scoring pipeline
