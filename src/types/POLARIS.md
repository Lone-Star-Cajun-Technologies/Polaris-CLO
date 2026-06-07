# types

## Purpose

Shared TypeScript type definitions for Polaris runtime contracts. This folder contains
interfaces, union types, and type guards that cross route boundaries — primarily for
worker result packets, Medic dispatch, and tracker/tool adapter surfaces.

## What belongs here

- `result-packet.ts` — `ResultPacket`, `SuccessResultPacket`, `FailedResultPacket`, `MedicPacket`, `MedicResult` types and `isFailedResultPacket` type guard
- `runtime-state.ts` — runtime execution state shape used across loop and finalize
- `linear.ts` — Linear tracker adapter types
- `tool-server-linear.d.ts` — ambient declarations for the Linear tool-server integration

## What does not belong here

- Domain-specific types with a clear owning route — those belong beside their module (e.g., `src/graph/`, `src/medic/`)
- Runtime implementations or logic — types only, no runtime behavior

## Editing rules

- `ResultPacket` discriminated union is authoritative for worker→Foreman→Medic communication. Do not widen it without updating all consumers.
- `MedicPacket` and `MedicResult` are the dispatch and return contracts for the Medic role. Keep aligned with `.polaris/skills/polaris-medic/SKILL.md`.
- Type guards belong here only when the type lives here.

## Related routes

- `src/loop/` — consumes `ResultPacket` for child result handling
- `src/medic/` — consumes `MedicPacket`/`MedicResult` for chart creation
