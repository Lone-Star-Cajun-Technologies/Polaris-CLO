<!-- polaris:draft -->
# steps

> Polaris draft — review and remove the `<!-- polaris:draft -->` marker to promote.

## Purpose

<!-- One paragraph describing what this folder does. -->

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
- `12-archive.ts` — src/finalize (finalize) — archives the final run snapshot (state, report, map, and telemetry) under `.polaris/runs/<run-id>/`

## What does not belong here

<!-- Explicit exclusions of files or responsibilities. -->

## Editing rules

<!-- Behavioral constraints for agents and humans. -->

## Architecture assumptions

- `12-archive.ts` runs after the finalize commit and remote delivery steps. It copies durable evidence into `.polaris/runs/<run-id>/` and does not create the directory unless finalizing a real run.
- Raw telemetry is read from `state.artifact_dir` or the default `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` and copied into the run archive.
- Per-run archive contents under `.polaris/runs/<run-id>/` are promoted by `artifact-policy.ts` as durable run evidence; workspace scratch under `.taskchain_artifacts/**` is not.

## Read before editing

- [POLARIS.md](../POLARIS.md)

## Related routes

<!-- Atlas route pointer to sibling or parent folders. -->
