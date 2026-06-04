# steps

## Purpose

Houses finalize step implementations (`step<Name>`) invoked by `src/finalize/index.ts` in strict order.

**Domain:** finalize
**Route:** src/finalize
**Taskchain:** polaris-finalize

## What belongs here

- `01-map-update.ts` — src/finalize (finalize)
- `02-map-validate.ts` — src/finalize (finalize)
- `03-schema-validate.ts` — src/finalize (finalize)
- `04-run-checks.ts` — src/finalize (finalize)
- `05-generate-report.ts` — src/finalize (finalize)
- `06-commit.ts` — src/finalize (finalize)
- `07-push.ts` — src/finalize (finalize)
- `08-create-pr.ts` — src/finalize (finalize)
- `09-update-state.ts` — src/finalize (finalize)
- `10-append-jsonl.ts` — src/finalize (finalize)
- `11-update-linear.ts` — src/finalize (finalize)
- `12-archive.ts` — src/finalize (finalize)

## What does not belong here

- Command registration and step sequencing logic (belongs in `src/finalize/index.ts`)
- Artifact classification policy (belongs in `src/finalize/artifact-policy.ts`)
- Loop state read/write helpers (belongs in `src/loop/checkpoint.ts`)

## Editing rules

- Export one step function per file; avoid cross-calling other step modules.
- Keep each step focused on its scoped side effect and fail loudly on hard errors.
- Preserve current step numbering contracts unless orchestrator step order is intentionally migrated.

## Architecture assumptions

- `runFinalize` orchestrates ordering, gates, and skip flags.
- Tracker update step must safely no-op when tracker or credentials are unavailable.
- State and telemetry paths are provided by orchestrator context.

## Read before editing

- [POLARIS.md](../POLARIS.md)

## Related routes

- `polaris.finalize` (parent route)
