# src/graph

## Purpose

The graph route owns extraction, resolution, query, and storage for the repository code graph, plus multi-language adapter selection, build coverage reporting, and governance outputs (notices and invalidation checks).

## What belongs here

- `parser/` — Tree-sitter runtime loading and symbol extraction pipeline
- `adapter/` — language-specific extraction/runtime adapters and registry wiring
- `adapter/*` — TypeScript/JavaScript, C, C++, C#, Dart, Go, Java, Kotlin, Python, Rust, Shell, Svelte, and Swift adapters registered in the default graph adapter registry
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

## Graph build workflow

Run `polaris graph build` to populate `.polaris/graph` with the code graph for the configured `repo.sourceRoots` (default: `src`).

This is a manual, repeatable prerequisite for impact-scan and cross-route-referral work. It is not run automatically.

```bash
npm run build
polaris graph build
```

Re-run `polaris graph build` after a major source change or before using `polaris graph impact` against an updated tree.

```bash
# Find files transitively impacted by a changed symbol
polaris graph impact <symbol-name> --file <path-to-file>
```

Future tooling will consume the graph artifacts under `.polaris/graph` for impact scans. The graph output is a generated artifact and should not be committed, with the exception of `.polaris/graph/NOTICES`, which is tracked for license attribution.

## Related routes

- `polaris.config` — source of `config.graph` defaults and schema
- `polaris.cli` — command surface (`graph build`, `graph query`, `graph impact`)
