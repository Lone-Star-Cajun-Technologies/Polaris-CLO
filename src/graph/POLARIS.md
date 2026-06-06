# src/graph

## Purpose

The graph route owns extraction, resolution, query, and storage for the repository code graph, plus language adapter selection, build coverage reporting, and governance outputs (notices and invalidation checks).

## What belongs here

- `parser/` — Tree-sitter runtime loading and symbol extraction pipeline
- `adapter/` — language-specific extraction/runtime adapters and registry wiring
- `capability/` — graph capability registry and build coverage reporting
- `resolver/` — import/call/defined-in edge construction and unresolved edge tracking
- `query/` — symbol lookup, callers/callees traversal, impact analysis, and graph stats
- `store/` — SQLite adapter, schema lifecycle, and persistence helpers
- `governance.ts` — notices + invalidation checks for graph artifact lifecycle
- `*.test.ts` under route folders — unit coverage for parser, resolver, query, store, and governance

## What does not belong here

- CLI command wiring (`src/cli/graph.ts`)
- Map/cognition ingestion behavior
- Loop state transitions and worker orchestration

## Editing rules

- Keep this route standalone; do not import from `src/map/`, `src/cognition/`, or `src/loop/`.
- Extraction and resolver passes must remain deterministic and transaction-safe.
- Query helpers must tolerate missing symbols and return stable ordering.
- Unsupported files should degrade at file level instead of failing the whole graph build.
- `writeGraphNotices` must be deterministic and safe to run repeatedly.
- Invalidation checks are trigger-driven by `config.graph.invalidationTriggers`; only emit supported reasons.

## Related routes

- `polaris.config` — source of `config.graph` defaults and schema
- `polaris.cli` — command surface (`graph build`, `graph query`, `graph impact`)
