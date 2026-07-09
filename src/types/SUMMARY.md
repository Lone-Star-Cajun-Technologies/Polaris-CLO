# Summary: types

## Purpose
Shared TypeScript type definitions for Polaris runtime contracts. Cross-route interfaces for worker result packets, run-health symptom reporting, Medic dispatch, tracker adapters, and runtime state.

## Core Concepts
- `ResultPacket` is a discriminated union (`SuccessResultPacket | FailedResultPacket`) — the authoritative contract between workers, the Foreman, and the Medic.
- `WorkerRunHealthSymptom` captures worker-reported symptoms that can be embedded in a sealed worker result.
- `MedicPacket` carries a failed result packet to the Medic role for diagnosis.
- `MedicRunHealthPacket` carries a run-health report to Medic for consult and treatment-packet handoff.
- `MedicResult` and `MedicRunHealthResult` are the Medic's return contracts after repair or consult.
- Type guards (`isFailedResultPacket`) live beside the types they guard.

## Architectural Role
This folder is the shared type boundary for Polaris inter-role communication. Routes that cross the worker/Foreman/Medic boundary consume from here rather than defining local types.

## Key Constraints
- Types only — no runtime logic or file I/O.
- `ResultPacket` discriminated union is stable; changes require updating all consumers.
- Do not add domain-specific types with a clear owning route.

## Important Relationships
- `src/loop/` — consumes `ResultPacket` for child result handling and run-health ingestion
- `src/medic/` — consumes `MedicPacket`/`MedicResult` and run-health consult types for chart creation
- `src/tracker/` — consumes tracker adapter types

## Current State
Contains `result-packet.ts` (ResultPacket, WorkerRunHealthSymptom, MedicPacket, MedicResult, MedicRunHealthPacket, MedicRunHealthResult), `runtime-state.ts`, `linear.ts`, and `tool-server-linear.d.ts`. All types added by POL-326 Medic role implementation are in `result-packet.ts`. SOL scoring and evidence types were added by POL-477 (SOL self-optimization cluster): `sol-evidence.ts` defines the normalized read model (`SolEvidence` and its sub-types) over completed run artifacts, and `sol-score.ts` defines the SOL scoring output model (`SolDimensionScore`, `SolForemanScoreReport`, `SolWorkerScoreReport`, `SolScoreReport`) with 0.0–1.0 dimensional scores and confidence tiers. The run-health symptom and consult contracts now live here as well so loop, Medic, and finalize can share a single schema.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
