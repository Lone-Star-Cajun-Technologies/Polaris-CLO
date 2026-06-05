# POL-325 Capability Matrix — Polaris vs CodeGraph

**Scope:** POL-334 comparative analysis for selective CodeGraph component extraction into Polaris (no external runtime dependency strategy, no recommendation decision).

## Capability Matrix

| CodeGraph subsystem (from POL-333) | Polaris atlas | GitNexus | SmartDocs | CodeGraph | Worker-context and token-efficiency gap |
| --- | --- | --- | --- | --- | --- |
| Graph data model (`nodes`, `edges`, `files`, symbol kinds) | File-route atlas only (`file-routes.json` / `needs-review.json`), no symbol graph | Provider-detected repo-analysis surface only; no in-repo typed graph model | Doc-level authority/provenance model, not code symbol graph | Rich typed symbol + relationship graph (`src/types.ts`) | Workers still gather structure via file reads and heuristics instead of direct symbol/edge lookup |
| SQLite persistence + indexed query layer (`src/db/schema.sql`, adapters, queries) | JSON sidecar maps; no relational symbol store | External tool abstraction; no Polaris-owned storage | Markdown/frontmatter lifecycle storage, no semantic index | SQLite + FTS5 + schema versioning + prepared query primitives | No low-latency semantic retrieval cache for worker prompts/context assembly |
| Tree-sitter extraction pipeline (`src/extraction/*`) | No AST parsing pipeline in map | External provider black-box (if available) | No parser stack | Deterministic AST-to-symbol extraction for many languages | Worker context lacks deterministic structural extraction; token use increases when probing code with ad-hoc reads |
| Reference resolution (`src/resolution/*`) | Route/domain inference only; no cross-file symbol resolution | Unknown proprietary internals; no local Polaris implementation | N/A | Import + name + framework matcher resolution to edges | Cross-file impact analysis currently manual for workers, increasing tool-call count |
| Graph traversal/query (`src/graph/*`) | Map query supports file/domain/taskchain filters only | Provider-level only | N/A | Callers/callees/impact/path queries | Polaris cannot answer dependency-flow questions from local graph state; workers read more files to infer call chains |
| Context builder (`src/context/*`) | No symbol-scoped context builder | Provider-level only | SmartDocs builds policy/docs context, not code topology context | Builds compact markdown/JSON context bundles from graph | Existing worker prompt compaction reduces instructions, but not repository reasoning payload size |
| MCP server tools (`src/mcp/*`) | Polaris has its own MCP tools for loop/status, not code-intel graph tools | Provider can exist, but not integrated as Polaris-owned graph service | N/A | Dedicated code-intel tools (`explore/search/trace/affected/context`) | Potentially useful patterns, but direct extraction would duplicate Polaris runtime tool surface |
| Indexing/sync watcher (`src/sync/*`) | Atlas update is changed-file oriented, not semantic incremental indexing | N/A | N/A | Incremental semantic sync with file-change tracking | No semantic freshness loop means repeated worker re-discovery costs tokens |
| CLI/installer shell (`src/bin`, `src/installer`) | Polaris has independent CLI/runtime orchestration | N/A | N/A | Operational wrapping for standalone CodeGraph product | Not aligned with selective extraction goal; no direct token benefit inside Polaris core |

## Subsystem Verdicts (extract / reimplement / skip)

| Subsystem | Verdict | Rationale | Proposed Polaris target location(s) | MIT attribution obligation (source notice location) |
| --- | --- | --- | --- | --- |
| Graph data model (`src/types.ts`) | **extract** | Highest leverage, low coupling. Provides stable shared vocabulary for symbols/edges/files used by extraction, persistence, and query. | `src/map/codegraph/types.ts` (canonical model), re-export from `src/cognition/index.ts` as needed | Preserve MIT license text from upstream `LICENSE` and record provenance for copied files; upstream sampled source files do not carry per-file MIT header comments |
| SQLite schema + query primitives (`src/db/schema.sql`, `src/db/queries.ts`, `src/db/sqlite-adapter.ts`) | **extract** | Directly enables fast local symbol retrieval and FTS-backed lookups for worker context packing; already aligned with local-first Polaris runtime. | `src/map/codegraph/db/schema.sql`, `src/map/codegraph/db/sqlite-adapter.ts`, `src/map/codegraph/db/queries.ts` | Include upstream MIT notice from root `LICENSE`; track copied upstream paths in THIRD_PARTY attribution note |
| Tree-sitter extraction core (`src/extraction/tree-sitter.ts`, `src/extraction/grammars.ts`, `src/extraction/languages/*`) | **extract** | Delivers deterministic symbol graph generation needed for token-efficient context assembly; core differentiator for replacing heuristic file reads. | `src/cognition/code-intel/extraction/*` with grammar loading + language extractors | MIT notice inherited from upstream `LICENSE`; retain provenance map for copied extractor files |
| Reference resolution (`src/resolution/import-resolver.ts`, `name-matcher.ts`, framework matchers) | **reimplement** | Valuable capability, but highly coupled and broad. Start with import/name resolution subset needed for Polaris impact queries; avoid wholesale framework surface at first pass. | `src/cognition/code-intel/resolution/import-resolver.ts`, `src/cognition/code-intel/resolution/name-matcher.ts` | If porting snippets, preserve MIT notice from upstream `LICENSE` for substantial copied portions |
| Graph traversal + query manager (`src/graph/traversal.ts`, `queries.ts`) | **reimplement** | Algorithms are straightforward; reimplement against Polaris-owned DB abstractions to avoid API drift while preserving required query semantics. | `src/cognition/code-intel/graph/traversal.ts`, `src/cognition/code-intel/graph/queries.ts` | If code is directly copied, include MIT attribution; if clean-room reimplementation, citation can remain design-reference only |
| Context builder (`src/context/index.ts`, `formatter.ts`) | **reimplement** | Polaris needs output tuned to worker-packet/compaction constraints rather than CodeGraph's MCP-oriented formatting. | `src/loop/context-builder.ts` or `src/cognition/code-intel/context-builder.ts` | Apply MIT attribution only for copied segments/templates |
| MCP server/tooling (`src/mcp/*`) | **skip** | Polaris already owns MCP/tool orchestration; extracting CodeGraph server would add overlapping runtime surface and governance complexity. | N/A | No extraction planned; no code attribution requirement beyond research citation |
| Sync watcher (`src/sync/*`) | **skip** (phase 1) | Useful later, but not required for initial worker token-efficiency gains. Batch/invocation-time indexing is sufficient for first integration wave. | N/A (defer candidate: `src/map/codegraph/sync/`) | No extraction in this phase |
| Installer/CLI shell (`src/installer/*`, `src/bin/*`) | **skip** | Product packaging concerns do not improve Polaris internal cognition stack and are out-of-scope for selective component adoption. | N/A | No extraction in this phase |

## Prioritized Extraction Candidate List

1. **Graph data model** (`src/types.ts`) → foundation for all downstream semantic operations.
2. **SQLite persistence layer** (`src/db/schema.sql` + adapter/query subset) → durable low-latency semantic retrieval.
3. **Tree-sitter parsing/extraction core** (`src/extraction/tree-sitter.ts` + `grammars.ts` + targeted language extractors) → deterministic symbol generation.

## Targeted Gap Analysis (Worker Context + Token Efficiency)

- Polaris already compacts worker prompts structurally (`compact` vs `full` modes), but worker repository reasoning still depends on broad file reads and manual cross-file inference.
- Atlas and SmartDocs are strong at **ownership/governance/document canon**, but they do not provide **symbol graph retrieval** for callers/callees/impact context.
- Integrating the three primary extraction candidates above enables:
  - precomputed symbol neighborhoods for worker packets,
  - smaller context payloads with higher precision,
  - fewer exploratory file-read calls for cross-file dependency reasoning.
- Reimplementing lightweight resolution + query layers on top of extracted model/storage/extraction components is the shortest path to measurable token and tool-call reductions without importing CodeGraph as a runtime dependency.

## Attribution Notes (MIT)

- Upstream license source: `colbymchenry/codegraph` root `LICENSE` (MIT).
- Upstream package declaration confirms MIT: `package.json` (`"license": "MIT"`).
- Observed sampled source files (`src/types.ts`, `src/index.ts`, `src/extraction/tree-sitter.ts`, `src/resolution/index.ts`, `src/db/sqlite-adapter.ts`) do not embed a separate per-file MIT header; attribution is carried by repository-level license.
- For Polaris extraction work, include:
  - MIT license text in a third-party attribution file in Polaris,
  - provenance mapping of copied upstream file paths and commit SHA,
  - optional SPDX/file-header annotations on extracted files for traceability.
