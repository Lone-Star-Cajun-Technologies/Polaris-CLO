# Summary: types

## Purpose
Shared TypeScript type definitions for Polaris runtime contracts. Cross-route interfaces for worker result packets, Medic dispatch, tracker adapters, and runtime state.

## Core Concepts
- `ResultPacket` is a discriminated union (`SuccessResultPacket | FailedResultPacket`) — the authoritative contract between workers, the Foreman, and the Medic.
- `MedicPacket` carries a failed result packet to the Medic role for diagnosis.
- `MedicResult` is the Medic's return contract after repair.
- Type guards (`isFailedResultPacket`) live beside the types they guard.

## Architectural Role
This folder is the shared type boundary for Polaris inter-role communication. Routes that cross the worker/Foreman/Medic boundary consume from here rather than defining local types.

## Key Constraints
- Types only — no runtime logic or file I/O.
- `ResultPacket` discriminated union is stable; changes require updating all consumers.
- Do not add domain-specific types with a clear owning route.

## Important Relationships
- `src/loop/` — consumes `ResultPacket` for child result handling and Medic dispatch
- `src/medic/` — consumes `MedicPacket`/`MedicResult` for chart creation
- `src/tracker/` — consumes tracker adapter types

## Current State
Contains `result-packet.ts` (ResultPacket, MedicPacket, MedicResult), `runtime-state.ts`, `linear.ts`, and `tool-server-linear.d.ts`. All types added by POL-326 Medic role implementation are in `result-packet.ts`.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
