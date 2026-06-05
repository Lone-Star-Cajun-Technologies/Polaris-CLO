# src/graph

## Purpose

The graph governance route owns graph artifact lifecycle controls: provenance notices and invalidation checks that detect when graph indexes must be rebuilt.

## What belongs here

- `governance.ts` — writes `NOTICES` attribution output and evaluates rebuild invalidation (`config-change`, `repo-change`)
- `*.test.ts` — unit tests for graph governance behavior

## What does not belong here

- Graph extraction/build implementation
- Map/cognition ingestion behavior
- Loop state transitions and worker orchestration

## Editing rules

- Keep this route standalone; do not import from `src/map/`, `src/cognition/`, or `src/loop/`.
- `writeGraphNotices` must be deterministic and safe to run repeatedly.
- Invalidation checks are trigger-driven by `config.graph.invalidationTriggers`; only emit supported reasons.

## Related routes

- `polaris.config` — source of `config.graph` defaults and schema
