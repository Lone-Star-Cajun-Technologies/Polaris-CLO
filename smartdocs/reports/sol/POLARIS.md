# smartdocs/reports/sol

## Purpose

Human-readable output surface for Self-Optimization Loop (SOL) evaluation reports and scorecards. This folder contains durable, review-oriented summaries derived from machine-readable SOL artifacts under `.polaris/sol/`.

## What belongs here

- SOL evaluation report architecture and taxonomy
- Human-readable Foreman, worker, provider, model, routing, token-efficiency, QC, intervention, and recommendation reports
- Aggregate scorecard summaries that link back to raw metric sources

## What does not belong here

- Raw telemetry or run-state JSON files (stay in `.taskchain_artifacts/` and `.polaris/`)
- Generated machine-readable scorecards (stay in `.polaris/sol/`)
- Unpromoted analysis drafts (use `smartdocs/raw/analysis/`)

## Editing rules

- Reports are read-only summaries; they do not mutate runtime behavior or provider policy.
- Every report must cite source evidence paths (run state, telemetry, result packets, QC artifacts, cluster state, router evidence).
- Keep report prose compact and link to canonical specs in `smartdocs/specs/active/`.
