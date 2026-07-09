# run-health

## Purpose

Defines the canonical run-health report artifact and its helper API. The run-health report
is the single source of truth for symptoms that occur during a Polaris run. It is used by
workers, Foreman, closeout, SOL, and Medic.

## What belongs here

- `schema.ts` — Zod schema, type exports, and `validateRunHealthReport` for the versioned
  `RunHealthReport` artifact. Includes sub-schemas for `RunHealthSymptom`,
  `PolicyBypassMetadata`, `MedicConsult`, `SourceActor`, and `SymptomSeverity`.
- `index.ts` — Atomic helper API: `createRunHealthReport`, `appendSymptom`,
  `readRunHealthReport`, `markBypassed`, `markMedicDecision`, and path helpers
  `getRunHealthReportPath` / `getRunHealthMarkdownPath`. Re-exports all schema types.
- `index.test.ts` — Unit tests covering schema validation, atomic write safety, missing
  report reads, immutability, and bypass metadata.

## Storage

Reports live at `.polaris/runs/<run-id>/run-health-report.json`.
An optional `.md` sibling may exist for operator review.
The report is **only created when symptoms occur** — absence means the run is healthy.

## Key constraints

- QC providers write to `.polaris/clusters/<cluster-id>/qc/` and are referenced by path
  from `evidence_refs`. **QC never writes symptoms to this module.**
- All mutations are atomic (temp-file + rename).
- All helpers return immutable (frozen) copies of the updated report.
- `readRunHealthReport` returns `null` for a missing file; it throws if the file exists but
  fails schema validation.

## Commands

```bash
# Run run-health tests
npx vitest run src/run-health
```

## Editing rules

- Bump `SCHEMA_VERSION` and update `RunHealthReport` whenever the schema shape changes.
- The `policy_bypass` and `medic_consult` fields are absent by default — absence has
  semantic meaning (no bypass granted; no Medic consulted). Do not default them to empty
  objects.
- `appendSymptom` requires the report to already exist; it does not silently create a new
  report. This keeps "first symptom" semantics explicit.
