# docs/spec

## Purpose

Architecture specifications, contracts, and planning documents for Polaris. These are the authoritative design references for the loop/map/finalize triad, ephemeral execution model, dispatch/compact contracts, run ledger, and issue hierarchy. Files here are pre-canonical until ingested into `smartdocs/docs/`.

## What belongs here

- `ephemeral-execution-architecture.md` — ephemeral worker model, session boundaries, bootstrap packet contract
- `ephemeral-validation-plan.md` — validation strategy for ephemeral execution
- `issue-hierarchy-doctrine.md` — cluster/parent/child issue hierarchy and ownership rules
- `polaris-compact-contracts.md` — CompactReturn schema and worker ↔ loop communication contract
- `polaris-dispatch-contract.md` — dispatch packet format and worker handoff contract
- `polaris-run-ledger.md` — global run ledger schema, JSONL event types, telemetry contract
- `smartdocs-summary-architecture.md` — SUMMARY.md architecture and precedence model
- `polaris-implementation-plan.md` — implementation planning notes (non-normative)

## What does not belong here

- Active promoted doctrine — belongs in `smartdocs/docs/doctrine/active/` after `polaris docs ingest`.
- Runtime state or session artifacts.

## Editing rules

- These files are the source-of-truth references while pre-canonical. Changes here may require updating promoted docs in `smartdocs/docs/` via re-ingest.
- Do not add implementation-level detail that belongs in route-local `POLARIS.md` files.

## Route model

- Files here feed into `polaris docs ingest` which classifies them as `spec-raw`, `spec-active`, or `architecture`.
- Until ingested, these docs inform but do not override runtime behavior.

## Related routes

- `docs/` — parent folder
- `smartdocs/docs/specs/` — promotion destination for spec files
