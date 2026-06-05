# POL-325 Integration Options: Option C vs Option D (POL-335)

## Scope and framing

This document evaluates only **Option C** (selective MIT component extraction into Polaris `src/`) and **Option D** (Polaris-native reimplementation inspired by CodeGraph) for extraction candidates identified in `smartdocs/specs/raw/pol-325-capability-matrix.md`.

Options A and B are intentionally out of scope.

## Decision matrix (per extraction candidate)

| Candidate component (from POL-334) | Option C: selective extraction | Option D: Polaris-native reimplementation | Recommendation | Why |
| --- | --- | --- | --- | --- |
| Graph data model (`src/types.ts`) | **Strong fit.** High code quality, low framework coupling, mostly plain TypeScript types/enums. Minimal dependency on CodeGraph runtime internals. | Feasible, but re-creating node/edge/kind taxonomy adds avoidable drift risk for no strategic gain. | **Choose Option C** | Fastest path to a stable shared vocabulary across extraction, storage, and query layers while keeping future adaptation costs low. |
| SQLite schema + query primitives (`src/db/schema.sql`, adapter/query subset) | **Partial fit.** Schema/index design is proven and high quality, but direct lift must be constrained to tables/indexes Polaris needs. Adapter internals have moderate coupling to CodeGraph connection abstractions. | Feasible and controllable; effort rises if done fully clean-room from day one. | **Hybrid C-first**: extract schema/query baseline, then Polaris-native adapter boundary | Preserves proven relational model and query shape while keeping Polaris ownership of runtime DB wiring and lifecycle policies. |
| Tree-sitter extraction core (`src/extraction/tree-sitter.ts`, `grammars.ts`, targeted language extractors) | **Selective fit.** Core parser/extractor logic is valuable and mature, but grammar loading and extractor registration are coupled to CodeGraph module layout. Tree-sitter version alignment must be explicitly managed. | Feasible but materially larger effort/risk; clean-room rewrite could diverge from proven extraction semantics and delay outcomes. | **Choose Option C (selective extraction), with Polaris-native orchestration wrapper** | Reuse deterministic extraction logic and language coverage now; isolate Polaris orchestration API so future refactors can decouple further without redoing parser logic. |

## Detailed Option C vs D assessment notes

### 1. Code quality and maintainability

- All three candidates are from mature, production-facing code paths and are well aligned with Polaris' TypeScript stack.
- Data model and SQL schema are the cleanest extraction surfaces (smallest moving parts, clearest interfaces).
- Tree-sitter extraction is high value but should be imported in bounded modules instead of as a broad subsystem lift.

### 2. Coupling to CodeGraph internals

- **Low coupling:** graph data model.
- **Moderate coupling:** SQLite adapter/query modules (connection/bootstrap utilities differ).
- **Moderate-high coupling:** extraction orchestration/grammar bootstrap points.
- Recommendation preserves low-risk direct lifts and isolates moderate-coupling areas behind Polaris-owned facades.

### 3. Tree-sitter compatibility implications

- Pin parser/runtime versions compatible with Polaris Node runtime and target grammars.
- Keep extracted extractor logic separate from Polaris orchestration so grammar/runtime upgrades can be managed at one boundary.
- Validate language subset first (the same initial subset selected in POL-334) before broad grammar expansion.

### 4. SQLite schema fit with Polaris atlas

- CodeGraph symbol graph storage should be treated as a **parallel runtime index**, not a replacement for atlas route metadata.
- Strong fit for read-heavy symbol and relationship queries (including FTS); atlas remains ownership/routing canon.
- Recommended integration model:
  - Atlas JSON artifacts remain source of truth for file-route and governance mapping.
  - Graph SQLite DB becomes a generated runtime artifact for semantic lookup and context shaping.

## MIT attribution obligations (required retention)

Polaris can remain proprietary while including MIT-licensed source. Required obligations for extracted source:

1. Preserve MIT copyright and permission notice.
2. Ensure license text from upstream CodeGraph `LICENSE` is included in Polaris third-party attribution materials.
3. For files copied into `src/`, include provenance annotations (source path + upstream commit) and retain any original headers if present.

### Where notices must be retained

- **Copied source files in `src/`**: retain existing upstream copyright/license header comments when present.
- **Repository-level attribution**: include CodeGraph MIT text in Polaris third-party notices/license bundle.
- **Provenance mapping**: maintain a file-level mapping of extracted files to upstream source path and commit SHA.

This satisfies MIT requirements without requiring Polaris to open-source proprietary code.

## Governance and runtime lifecycle

### Graph artifact storage

- Store graph DB/artifacts as Polaris runtime-generated assets (e.g., runtime/map/cognition artifact locations), not as canonical SmartDocs content.
- Keep artifact paths deterministic and workspace-local for repeatable worker execution.

### Exclusion from cognition ingestion

- Exclude generated graph SQLite files and derived graph artifacts from SmartDocs cognition ingestion paths.
- Treat graph artifacts as computed state, not authored canon.

### Graph data lifecycle as runtime artifact

- Create/update during indexing phases.
- Consume during worker context construction/query phases.
- Invalidate or rebuild on repository changes/config shifts.
- Keep lifecycle controls in runtime orchestration, not in tracker-specific adapters.

## Tracker-agnostic architecture compliance

Recommended path is compliant:

- Option C usage is limited to parser/model/storage primitives, not tracker logic.
- Polaris-native wrappers own runtime orchestration boundaries and interfaces.
- No Linear-specific assumptions are introduced in graph model, extraction, storage, or query surfaces.
- Graph capability remains under core Polaris runtime/cognition layers and can operate with `local`, `spec`, `linear`, or `mcp-bridge` adapters.

## Final recommendation summary

- **Graph data model:** Option C.
- **SQLite schema/query baseline:** Option C for schema/query patterns + Polaris-native adapter boundary.
- **Tree-sitter extraction core:** Option C selective extraction + Polaris-native orchestration layer.

This is the shortest path to a proven semantic foundation while preserving Polaris ownership, tracker-agnostic design, and governance controls.
