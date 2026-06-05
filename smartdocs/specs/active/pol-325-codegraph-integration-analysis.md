---
kind: spec
status: active
source: POL-336
created: 2026-06-05
depends_on:
  - pol-325-codegraph-architecture.md
  - pol-325-capability-matrix.md
  - pol-325-integration-options.md
source_paths:
  - smartdocs/specs/raw/pol-325-codegraph-architecture.md
  - smartdocs/specs/raw/pol-325-capability-matrix.md
  - smartdocs/specs/raw/pol-325-integration-options.md
related:
  - POL-325
  - POL-333
  - POL-334
  - POL-335
---

# POL-325 CodeGraph Integration Analysis (Final Recommendation)

## Executive summary and strategic direction

Polaris should integrate selected CodeGraph capabilities into the proprietary codebase through a **per-component Option C vs Option D model**:

- **Option C (selective MIT adoption)** for low-coupling, high-leverage primitives (data model, schema/query baseline, extraction core).
- **Option D (Polaris-native implementation)** for higher-level runtime behaviors (resolution, traversal orchestration, context assembly) where tracker-agnostic boundaries and Polaris-specific runtime control matter most.

This yields the shortest path to production value while preserving Polaris ownership of runtime interfaces, governance policy, and long-term maintainability.

## CodeGraph architecture summary

CodeGraph is a local-first code intelligence stack with this core pipeline:

1. Tree-sitter parsing and language extractors generate deterministic symbol data.
2. Symbols and relationships persist in SQLite (including FTS5 support).
3. Resolver and graph traversal layers derive cross-file relationships and impact paths.
4. Context builder produces compact, query-driven payloads for agent workflows.

For Polaris, the relevant takeaway is that CodeGraph’s strongest reusable assets are deterministic extraction + typed graph model + indexed persistence; product-level wrappers (MCP surface, installer shell, standalone CLI) are not required for phase-1 Polaris integration.

## Component extraction plan (C vs D verdicts)

| Component area | Verdict | Polaris target location(s) | Rationale |
| --- | --- | --- | --- |
| Graph data model (`nodes`, `edges`, `files`, enums/types) | **C** | `src/map/codegraph/types.ts` | Low coupling and immediate value as shared semantic vocabulary. |
| SQLite schema + query baseline | **C (bounded)** | `src/map/codegraph/db/schema.sql`, `src/map/codegraph/db/queries.ts` | Proven schema/index design should be reused; keep extraction bounded to required tables and query surfaces. |
| SQLite runtime adapter boundary | **D wrapper around C baseline** | `src/map/codegraph/db/sqlite-adapter.ts` | Polaris should own connection lifecycle, migration orchestration, and runtime policy integration. |
| Tree-sitter extraction core and selected language extractors | **C (selective)** | `src/cognition/code-intel/extraction/*` | Deterministic extraction is high leverage; adopt core logic while keeping Polaris-owned orchestration boundary. |
| Reference resolution | **D** | `src/cognition/code-intel/resolution/*` | Implement Polaris-targeted subset first to avoid broad framework-coupled import. |
| Graph traversal/query orchestration | **D** | `src/cognition/code-intel/graph/*` | Keep query APIs and traversal contracts Polaris-native and tracker-agnostic. |
| Worker context builder from graph neighborhoods | **D** | `src/cognition/code-intel/context-builder.ts` | Must align with Polaris packet/compaction model and runtime constraints. |
| MCP tooling, sync watcher, installer/standalone CLI | **Skip (phase 1)** | N/A | Not required for first integration wave; duplicates Polaris runtime surfaces. |

## MIT attribution requirements

CodeGraph is MIT-licensed. Polaris can keep proprietary distribution while extracting selected source, provided attribution obligations are met:

1. Retain the upstream MIT copyright/permission notice.
2. Include CodeGraph MIT license text in Polaris third-party notices.
3. Maintain provenance mapping for copied files (upstream repo path + commit SHA).
4. Preserve upstream file headers where present; add SPDX/provenance headers for extracted files when needed for traceability.

### Required notice placement

- **Copied source files under `src/`**: preserve upstream notices and add provenance metadata when notices are absent.
- **Repository-level attribution**: include CodeGraph MIT text in Polaris third-party license bundle.
- **Governance record**: maintain a machine-readable provenance map for extracted files and upstream commit pins.

## Governance model for graph artifacts

Graph outputs are **runtime-generated artifacts**, not canon:

- **Storage:** deterministic runtime artifact locations (workspace-local, reproducible paths).
- **Cognition exclusion:** generated graph DB/files must be excluded from SmartDocs ingestion.
- **Lifecycle:** build/update during indexing phases; consume during context/query phases; invalidate/rebuild on repository or configuration change.
- **Ownership boundary:** runtime lifecycle controls live in Polaris core runtime, not tracker adapters.

## Phased implementation roadmap

### Phase 1 — Foundation (model + storage)

- Implement graph type model and SQLite schema/query baseline.
- Deliver Polaris-owned DB lifecycle adapter on top of adopted schema primitives.
- **Issue:** [POL-337](https://linear.app/lsctech/issue/POL-337/implement-codegraph-data-model-and-sqlite-baseline-in-polaris)

### Phase 2 — Deterministic extraction

- Integrate tree-sitter extraction core and selected language extractors.
- Write extracted symbols/edges into Polaris graph store.
- **Issue:** [POL-338](https://linear.app/lsctech/issue/POL-338/implement-tree-sitter-extraction-pipeline-integration-for-polaris-code)

### Phase 3 — Polaris-native graph intelligence surface

- Implement Polaris-native resolution subset, traversal/query APIs, and context builder.
- Optimize worker context payloads using precomputed graph neighborhoods.
- **Issue:** [POL-339](https://linear.app/lsctech/issue/POL-339/implement-polaris-native-resolution-traversal-and-context-builder-on)

### Phase 4 — Governance hardening

- Enforce artifact storage rules, ingestion exclusion, provenance retention, and lifecycle controls.
- **Issue:** [POL-340](https://linear.app/lsctech/issue/POL-340/implement-graph-artifact-governance-and-lifecycle-controls-in-polaris)

## Risks and open questions

### Risks

- Tree-sitter/runtime version drift across environments.
- Over-scoping initial language coverage before core flow is stable.
- Adapter boundary leakage that could reintroduce tracker-specific coupling.
- Governance gaps causing generated graph artifacts to leak into canon ingestion.

### Open questions

1. Which initial language set is required for first measurable worker token/tool-call reduction?
2. What graph freshness SLA (on-demand vs incremental update cadence) best fits Polaris execution loops?
3. Which runtime metrics will be the acceptance gate for phase transitions (query latency, token delta, tool-call delta)?

## Closeout status

POL-325 is complete at analysis level, and implementation work is now split into POL-337 through POL-340.
