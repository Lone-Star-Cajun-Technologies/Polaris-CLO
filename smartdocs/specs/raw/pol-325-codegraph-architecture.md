# CodeGraph Internal Architecture & Data Model

**Source**: [github.com/colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) (MIT License)  
**Date**: June 2026  
**Purpose**: Foundational research document for Polaris repository intelligence layer evaluation (POL-325)

---

## Executive Summary

CodeGraph is a **local-first code intelligence platform** that parses any supported codebase with tree-sitter, stores extracted symbols and relationships in SQLite (with FTS5 full-text search), and exposes a queryable knowledge graph to AI agents over MCP (Model Context Protocol). The system is deterministic—derived entirely from AST parsing, not LLM-summarized.

**Key characteristics:**
- **Extraction**: Deterministic tree-sitter parsing → AST → symbol extraction
- **Storage**: SQLite with FTS5, schema-versioned, per-project `.codegraph/` directory
- **Resolution**: Multi-stage reference resolver (imports, name matching, framework patterns)
- **Query**: Graph traversal (callers, callees, impact radius), context building for AI agents
- **Delivery**: CLI + MCP server + library API (single npm package)
- **Performance**: Benchmarked 16–40% cost reduction and 58% fewer tool calls vs. baseline agent exploration

---

## Architecture Overview

### Layered Pipeline

```
Source Files
    ↓
[ExtractionOrchestrator: tree-sitter parsing]
    ↓
[Database: nodes/edges/files in SQLite]
    ↓
[ReferenceResolver: imports, name-matching, framework routes]
    ↓
[GraphQueryManager / GraphTraverser: callers, callees, impact]
    ↓
[ContextBuilder: markdown/JSON for AI agents]
    ↓
[MCP Server / CLI / Library API]
```

### Module Structure

| Module | Purpose |
|--------|---------|
| `src/index.ts` | Public API surface: `CodeGraph` class (`init`, `open`, `close`, `indexAll`, `sync`, `searchNodes`, `getCallers`, `getCallees`, `getImpactRadius`, `buildContext`) |
| `src/db/` | SQLite backend: `DatabaseConnection`, `QueryBuilder`, `schema.sql`. Supports `better-sqlite3` (native) with automatic fallback to `node-sqlite3-wasm` |
| `src/extraction/` | Tree-sitter orchestration, per-language extractors, WASM grammars. Standalone extractors for Svelte, Vue, Liquid, Delphi |
| `src/resolution/` | `ReferenceResolver`: imports, path aliases (tsconfig), name matching, 14 framework pattern matchers (Django, Rails, Express, Laravel, FastAPI, Flask, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, Vue/Nuxt) |
| `src/graph/` | `GraphTraverser` (BFS/DFS, impact radius, path finding), `GraphQueryManager` (high-level graph queries) |
| `src/context/` | `ContextBuilder`: formats symbol information + related code as markdown or JSON for agent consumption |
| `src/search/` | Full-text query parser for FTS5 |
| `src/sync/` | `FileWatcher` (native FSEvents/inotify/RDCW) with debounce; git-hook helpers |
| `src/mcp/` | MCP server: `MCPServer`, tools, transport, `server-instructions.ts` (agent-facing guidance) |
| `src/installer/` | Multi-agent installer (Claude Code, Cursor, Codex, opencode, Hermes, Gemini, Antigravity, Kiro) |
| `src/bin/codegraph.ts` | CLI (commander): `install`, `init`, `uninit`, `index`, `sync`, `status`, `query`, `files`, `context`, `affected`, `serve --mcp` |

---

## Data Model

### Graph Nodes

A **node** represents a code symbol extracted from the AST. Defined in `src/types.ts`:

```typescript
interface Node {
  id: string;                    // Hash of (file path + qualified name)
  kind: NodeKind;                // See NodeKind enum below
  name: string;                  // Simple name (e.g., "calculateTotal")
  qualifiedName: string;         // Fully qualified (e.g., "src/utils.ts::MathHelper.calculateTotal")
  filePath: string;              // Relative to project root
  language: Language;            // Detected language
  startLine: number;             // 1-indexed
  endLine: number;
  startColumn: number;           // 0-indexed
  endColumn: number;
  docstring?: string;            // Extracted from comments
  signature?: string;            // Function/method signature
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  decorators?: string[];         // JSON array
  typeParameters?: string[];     // Generic type params
  updatedAt: number;             // Timestamp (ms)
}
```

#### NodeKind Enumeration

| Kind | Meaning |
|------|---------|
| `file` | Source file |
| `module` | Module/package |
| `class` | Class definition |
| `struct` | Struct (Rust, C, etc.) |
| `interface` | Interface |
| `trait` | Trait (Rust) |
| `protocol` | Protocol (Swift, ObjC) |
| `function` | Top-level function |
| `method` | Instance or class method |
| `property` | Object property or field |
| `field` | Struct/class field |
| `variable` | Local or module variable |
| `constant` | Const declaration |
| `enum` | Enumeration |
| `enum_member` | Enum variant |
| `type_alias` | Type alias |
| `namespace` | Namespace |
| `parameter` | Function/method parameter |
| `import` | Import statement node |
| `export` | Export statement node |
| `route` | Web framework route (synthesized by resolver) |
| `component` | UI component (React, Vue, Svelte) |

#### Supported Languages

**With tree-sitter extraction:**  
TypeScript, JavaScript, TSX, JSX, Python, Go, Rust, Java, C, C++, C#, PHP, Ruby, Swift, Kotlin, Dart, Lua, Luau, Objective-C, YAML, Scala, XML, Properties, Liquid, Twig

**With specialized extractors:**  
Svelte, Vue, Delphi/Pascal (via standalone extractors for template/DSL formats)

### Graph Edges

An **edge** models a relationship between two nodes:

```typescript
interface Edge {
  source: string;                // Source node ID
  target: string;                // Target node ID
  kind: EdgeKind;                // See EdgeKind enum below
  metadata?: Record<string, unknown>;  // Context (e.g., argument count)
  line?: number;                 // Where relationship occurs in source
  column?: number;
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';  // How it was derived
}
```

#### EdgeKind Enumeration

| Kind | Meaning |
|------|---------|
| `contains` | Parent contains child (file→class, class→method) |
| `calls` | Function/method calls another |
| `imports` | File imports from another |
| `exports` | File exports symbol |
| `extends` | Class/interface extends |
| `implements` | Class implements interface |
| `references` | Generic reference |
| `type_of` | Variable/parameter has type |
| `returns` | Function returns type |
| `instantiates` | Creates instance of class |
| `overrides` | Method overrides parent method |
| `decorates` | Decorator applied to symbol |

### File Records

Metadata about indexed files:

```typescript
interface FileRecord {
  path: string;                  // Relative to project root
  contentHash: string;           // SHA for change detection
  language: Language;
  size: number;                  // Bytes
  modifiedAt: number;            // Filesystem mtime (ms)
  indexedAt: number;             // When last indexed (ms)
  nodeCount: number;             // Symbols extracted
  errors?: ExtractionError[];    // Any parse/extract errors
}
```

---

## SQLite Storage Schema

CodeGraph uses **SQLite with FTS5** full-text search. Schema is version-tracked and located at `src/db/schema.sql`.

### Core Tables

#### `nodes`
Stores all extracted symbols. Primary key: `id` (TEXT). Columns include all fields from the `Node` interface above, plus indexed columns for fast queries.

**Key indexes:**
- `idx_nodes_kind` — Filter by symbol type
- `idx_nodes_name` — Case-sensitive name lookup
- `idx_nodes_qualified_name` — Fully qualified lookup
- `idx_nodes_file_path` — All symbols in a file
- `idx_nodes_language` — Filter by language
- `idx_nodes_file_line` — Composite (file, start_line) for range queries
- `idx_nodes_lower_name` — Case-insensitive name search

#### `nodes_fts` (Virtual table)
Full-text search index over node names, qualified names, docstrings, and signatures. Uses FTS5 with automatic triggers to keep in sync with `nodes` table.

#### `edges`
Stores all graph relationships. Columns: `source` (TEXT FK), `target` (TEXT FK), `kind` (TEXT), `metadata` (JSON), `line`, `col`, `provenance`.

**Key indexes:**
- `idx_edges_kind` — Filter by edge type
- `idx_edges_source_kind` — Find outgoing edges from node (callers, references)
- `idx_edges_target_kind` — Find incoming edges to node (callees, references)

**Design note:** Intentionally omit narrow `idx_edges_source` / `idx_edges_target` indexes; composite indexes cover those queries via left-prefix scan, reducing write overhead.

#### `files`
Tracks indexed files for incremental re-sync. Columns: `path` (PK), `content_hash`, `language`, `size`, `modified_at`, `indexed_at`, `node_count`, `errors` (JSON).

#### `unresolved_refs`
Temporary table for references that need post-indexing resolution. Used during multi-pass extraction to defer complex resolution (e.g., transitive imports, cross-file name matching).

**Columns:** `from_node_id`, `reference_name`, `reference_kind`, `line`, `col`, `candidates` (JSON array), `file_path`, `language`.

### Database Connection Layer

**Abstraction:** `DatabaseConnection` class in `src/db/` provides:
- Prepared statement management
- Transaction coordination
- Automatic schema migration on version mismatch
- Transparent fallback from `better-sqlite3` (native) to `node-sqlite3-wasm` if native binding unavailable

**Availability detection:**
```
1. Try require('better-sqlite3')
2. If fails → fall back to node-sqlite3-wasm
3. Queries work identically; performance differs (~2–5x slower on wasm)
```

---

## Extraction Pipeline

### ExtractionOrchestrator

**Flow:**
1. **File discovery**: Scan project, respect `.gitignore`, detect language by extension
2. **Per-language extraction**: Route each file to appropriate language extractor
3. **Tree-sitter parsing**: Call WASM grammar with source, walk AST
4. **Symbol extraction**: Traverse AST, emit `Node` records for each symbol
5. **Relationship emission**: Emit `Edge` records for syntactic relationships (calls, contains, etc.)
6. **Unresolved reference capture**: Collect references that require cross-file resolution

### Tree-Sitter Approach

**Key characteristics:**
- **Grammar coverage**: WASM-compiled tree-sitter grammars for 20+ languages
- **AST-native**: Directly parse source → AST node; no intermediate representation
- **Language-specific extractors**: One extractor per language in `src/extraction/languages/`
- **Query predicates**: Use tree-sitter S-expressions to match AST patterns (e.g., method definitions, function calls)
- **Deterministic**: No LLM summarization; derived purely from syntax

**Example workflow (TypeScript):**
```
1. Load ts-language WASM grammar
2. Parse source: Parser.parse(code) → tree (SyntaxTree)
3. Query AST for function definitions: (function_declaration name: (identifier) @name)
4. For each match, extract: name, signature, docstring, location, parameters
5. Query for call expressions: (call_expression function: (_) @callee arguments: (_) @arg)
6. Emit edges: caller→callee with EdgeKind='calls'
```

### Standalone Extractors

Non-tree-sitter languages handled by specialized extractors:
- **`svelte-extractor.ts`** — Parses Svelte templates, extracts component structure
- **`vue-extractor.ts`** — Vue single-file components
- **`liquid-extractor.ts`** — Liquid templates
- **`dfm-extractor.ts`** — Delphi/Pascal form files

These typically use regex or handwritten parsers for template syntax.

### Off-Main-Thread Parsing

**`parse-worker.ts`**: Heavy parsing offloaded to Worker thread to avoid blocking UI/MCP server. Coordinator distributes files to worker pool, collects results.

---

## Reference Resolution

### ReferenceResolver

**Purpose**: Transform raw extracted references into concrete edges. Multi-stage:

#### Stage 1: Import Resolution (`import-resolver.ts`)
- **Input**: Raw `import` statements (name, source file)
- **Process**:
  - Resolve file paths (relative, absolute, node_modules)
  - Handle path aliases (`tsconfig.json` `compilerOptions.paths`, Cargo workspace members)
  - Emit `imports` edges
- **Output**: `Edge(source=file, target=imported_symbol, kind='imports')`

#### Stage 2: Name Matching (`name-matcher.ts`)
- **Input**: Unresolved references (variable types, function arguments, return types)
- **Process**:
  - Search symbol table for matching names (scope rules: local → import → global)
  - Handle overloading (function signatures)
- **Output**: `Edge(source=reference_site, target=resolved_target, kind='references' or 'type_of')`

#### Stage 3: Framework Pattern Matching (`frameworks/`)
- **Input**: Routing files, controller registrations
- **Matchers** (one per framework):
  - Django: `path()` patterns → routes + handler methods
  - Rails: `routes.rb` → URL patterns + controller actions
  - Express: `app.get()`, `app.post()` → route nodes + handler functions
  - Laravel: `routes/{web,api}.php` → web routes + controller methods
  - FastAPI/Flask: `@app.route()` decorators → route nodes
  - ASP.NET: Controller + action attribute patterns
  - React Router: `<Route>` configs → component bindings
  - Vue Router: `route` configs → component imports
  - Gin, Axum, Spring Boot, Vapor, SvelteKit, Nuxt: Framework-specific routing DSLs

**Output**: Synthesize `route` nodes + `references` edges to handlers.

### Resolution Ordering

1. **During extraction**: Capture local (within-file) relationships, collect cross-file references
2. **Post-extraction**: Run import resolver (before name matching — imports are higher confidence)
3. **After import resolution**: Run name matcher on remaining unresolved references
4. **Framework patterns**: Scan detected routing files, emit route nodes + edges

---

## Graph Query Engine

### GraphTraverser

Supports graph algorithms:

**Depth-First Search (DFS)**
```
traverseDFS(startNode, kind?: EdgeKind) → Node[]
```
Recursively follow edges of specified kind.

**Breadth-First Search (BFS)**
```
traverseBFS(startNode, kind?: EdgeKind, maxDepth?: int) → Node[]
```
Layer-by-layer traversal with depth limit.

**Impact Radius**
```
getImpactRadius(nodeId, edgeKind) → Set<Node>
```
Find all reachable nodes through edges of specified kind (e.g., what breaks if I change this function?).

**Path Finding**
```
findPath(source, target, edgeKind?) → Node[]
```
Shortest path between two nodes.

### GraphQueryManager

High-level queries:

**Callers**
```
getCallers(functionId) → Function[]
```
All functions that call the given function (reverse `calls` edges).

**Callees**
```
getCallees(functionId) → Function[]
```
All functions called by the given function (`calls` edges).

**Affected Symbols**
```
getAffectedSymbols(changedFile) → Symbol[]
```
What symbols might be broken by changes to a file? (follow `imports`, `references` edges).

---

## MCP Integration Surface

### MCP Server (`src/mcp/MCPServer`)

CodeGraph exposes a Model Context Protocol server. Agents (Claude Code, Cursor, Codex, opencode, etc.) connect to this server and call tools.

**Transport**: Stdio (agent ↔ CodeGraph server via JSON-RPC).

**Lifecycle**:
1. Agent starts: `codegraph serve --mcp`
2. Server initializes: loads project index from `.codegraph/`, emits MCP `initialize` response
3. Server emits `initialize` response with:
   - `serverInfo`
   - Capabilities (list of tools)
   - **Agent-facing instructions** (`server-instructions.ts`): guidance on how to use each tool

**Tools Exposed**:

| Tool | Purpose | Input | Output |
|------|---------|-------|--------|
| `codegraph_explore` | Query knowledge graph for symbol info, callers, callees, context | Symbol name, query type | Markdown-formatted results with code snippets |
| `codegraph_search` | Full-text search over symbols + docstrings | Search term | List of matching symbols with locations |
| `codegraph_trace` | Trace call flow between two symbols | source, target | Call path + intermediate symbols |
| `codegraph_affected` | Impact analysis: what changes if I modify this file? | File path | List of affected symbols |
| `codegraph_context` | Build rich context (entry points, types, related code) | Symbol ID | Markdown/JSON with code snippets, type info, docs |
| `codegraph_status` | Health check; show pending syncs | — | Sync status, error log |

**Server Instructions** (`src/mcp/server-instructions.ts`):
- Single source of truth for agent-facing guidance
- Returned in MCP `initialize` response
- Tells agent how/when to use each tool
- Previously duplicated in agent config files; now centralized (issue #529)

### Agent-Specific Configuration

**Multi-agent installer** (`src/installer/`) handles:
- **Claude Code** — `.claude/mcp.json` (MCP server config)
- **Cursor** — `.cursor/mcp.json` + special `--path` argument (Cursor cwd quirk workaround)
- **Codex CLI** — `~/.codex/mcp_servers.toml` (hand-rolled TOML serializer preserves user structure)
- **opencode** — `opencode.jsonc` (JSON with comments, auto-detected or created)
- **Hermes Agent, Gemini CLI, Antigravity IDE, Kiro** — Agent-specific config formats

Each agent target (`targets/*.ts`) owns its:
- Config file path
- MCP JSON/TOML/JSONC writing logic
- Install/uninstall logic

---

## Indexing Strategy

### Initial Indexing (`codegraph init -i`)

**Flow:**
1. Create `.codegraph/` directory
2. Initialize SQLite database with schema version 1
3. Discover files (respect `.gitignore`)
4. Extract all files:
   - Tree-sitter parse each file
   - Emit nodes + local edges
   - Collect unresolved references
5. Resolve references (import resolution, name matching, framework patterns)
6. Commit all nodes/edges to database
7. Write `.codegraph/index-manifest.json` with metadata

**Time:** O(# files + # symbols); parallelized across CPU cores.

### Incremental Sync (`codegraph sync`)

**Strategy:** File hash + mtime tracking
1. Scan working tree, compute (size, mtime, content hash) for each source file
2. Compare against `files` table:
   - **Unchanged**: Skip
   - **Modified**: Re-extract, delete old nodes, insert new nodes
   - **New**: Extract, insert
   - **Deleted**: Delete nodes, update manifest
3. Re-run reference resolution (only on affected files + their dependencies)
4. Update `files` table with new hashes/mtimes

### Auto-Syncing (Live Watching)

**Enabled by default; no config required.**

**Mechanism** (`src/sync/FileWatcher`):
1. Native OS file watcher (FSEvents on macOS, inotify on Linux, RDCW on Windows)
2. Debounce: accumulate file events for 2 seconds (default, tunable via `CODEGRAPH_WATCH_DEBOUNCE_MS`, clamped to [100ms, 60s])
3. On debounce expiry: run `codegraph sync` asynchronously
4. **Staleness banner**: During debounce window, MCP responses that would reference a still-pending file prepend warning if result references a pending file; agent told to `Read` directly
5. **Connect-time catch-up**: When MCP server (re)connects, run fast (size, mtime, hash) reconciliation before first query

**Benefit**: Agents always query current index; graph never goes stale.

### Performance Characteristics

**Initial index (VS Code, 10k files):** ~2–5 minutes (depends on CPU, disk speed)

**Incremental sync (1–10 modified files):** <1 second

**Query (getCallers, getCallees, search):** <100ms (in-memory SQLite cache + indexes)

**MCP response latency:** <500ms typical (includes serialization to markdown/JSON)

---

## Local-First Operation Model

### No External Services

- **No cloud connectivity required** — all parsing, indexing, and queries run locally
- **No API keys** — no authentication, no rate limits
- **SQLite database is the single source of truth** — stored in project `.codegraph/`

### Per-Project Index

- Index directory: `.codegraph/` (in project root)
- Contains: `index.db` (SQLite), `.codegraph/index-manifest.json` (metadata)
- Can be gitignored or committed (typically ignored)
- Size: typically 10–50% of source size (depends on symbol density)

### Runtime Dependencies

**Node.js:**
- Required version: `>=20.0.0 <25.0.0` (enforced in `src/bin/node-version-check.ts`)
- Bundled runtime available via `npm i -g @colbymchenry/codegraph` (no separate Node installation needed)

**Native dependencies:**
- `better-sqlite3` (optional native binding) — if installed, used for 3–5x faster queries
- `node-sqlite3-wasm` — fallback if native binding unavailable (works on any platform, slower)
- Both transparently swappable

**Tree-sitter WASM grammars:**
- Bundled in npm package at `src/extraction/wasm/`
- Loaded at runtime from `dist/extraction/wasm/` after build

---

## Determinism & Reproducibility

### Extraction Determinism

All node/edge generation is **deterministic**:
- Given the same source file + tree-sitter grammar version, identical nodes are always extracted
- No randomness, no LLM, no heuristic divergence
- Output is reproducible across machines

### Schema Versioning

- Schema version tracked in `schema_versions` table
- New schema changes require explicit migration code
- Existing databases auto-migrate on first connection (if migration script exists)
- Prevents silent incompatibilities

### Content Hashing

- Each file tracked by SHA-256 content hash
- Change detection: hash mismatch → re-extract
- Prevents false positives from timestamp-only changes

---

## Performance & Optimization

### Benchmark Results (vs. baseline agent exploration)

Tested across 7 real-world open-source codebases (median of 4 runs):

| Codebase | Language | Cost | Tokens | Time | Tool calls |
|----------|----------|------|--------|------|------------|
| VS Code | TypeScript · 10k files | 18% cheaper | 64% fewer | 11% faster | 81% fewer |
| Excalidraw | TypeScript · 640 | even | 25% fewer | 27% faster | 40% fewer |
| Django | Python · 3k | 8% cheaper | 60% fewer | 13% faster | 77% fewer |
| Tokio | Rust · 790 | even | 38% fewer | 18% faster | 57% fewer |
| OkHttp | Java · 645 | 25% cheaper | 54% fewer | 31% faster | 50% fewer |
| Gin | Go · 110 | 19% cheaper | 23% fewer | 24% faster | 44% fewer |
| Alamofire | Swift · 110 | 40% cheaper | 64% fewer | 33% faster | 58% fewer |

**Mechanism**: Agents answer flow/structure questions directly from CodeGraph instead of spawning file-reading sub-agents.

### Query Optimization

- **Prepared statements** — statements compiled once, reused
- **Index coverage** — queries leverage composite indexes; avoided dead-weight narrow indexes
- **In-memory SQLite cache** — results cached by default SQLite library
- **Lazy loading** — context building streams results incrementally

---

## Error Handling & Fallbacks

### Extraction Errors

If parsing a file fails (syntax error, unsupported construct):
- Record error in `FileRecord.errors` (JSON array)
- Continue indexing other files (non-fatal)
- Agent informed of parse errors via MCP tool

### Database Failures

- **Connection loss**: Retry with exponential backoff
- **Schema mismatch**: Attempt auto-migration; if fails, emit clear error message

### Native Binding Unavailable

- Graceful fallback from `better-sqlite3` → `node-sqlite3-wasm`
- ~2–5x slower but fully functional
- User can check active backend via `codegraph status`

---

## Integration Points for Polaris

### Capability Comparison Targets

1. **Symbol extraction completeness** — does CodeGraph extract all symbol kinds Polaris needs?
2. **Cross-file reference resolution** — how accurate is import + name matching?
3. **Framework routing coverage** — do the 14 framework matchers cover Polaris workflows?
4. **Query latency** — acceptable for MCP integration?
5. **Index size vs. codebase size** — storage efficiency?
6. **Incremental re-indexing speed** — can it keep pace with live editing?

### MCP Server Adaptation Points

- Tool interface is stable (JSON-RPC over stdio)
- Agent-facing instructions live in `server-instructions.ts` — single touch point for behavior tuning
- Add new tools by extending `src/mcp/tools.ts` + updating server-instructions

### Custom Language / Framework Support

- Add language: write `src/extraction/languages/new-language.ts` extractor
- Add framework: add matcher in `src/resolution/frameworks/new-framework.ts`
- No modifications to core extraction/resolution pipeline required

---

## Known Limitations

1. **Async/await flow**: CodeGraph tracks calls but not async dependency chains (e.g., Promise then-chains)
2. **Dynamic imports**: Runtime `import()` or `require()` calls not resolved (static analysis limitation)
3. **Cross-language flows**: Limited support for polyglot projects (e.g., native modules calling JS) — some frameworks (iOS, React Native) have explicit matchers
4. **Macro expansion**: Rust macros, C preprocessor directives not fully expanded before parsing

---

## Summary Table: Key Subsystems

| Subsystem | Role | Key Files | Dependencies |
|-----------|------|-----------|--------------|
| Extraction | Parse source → AST → symbols | `src/extraction/`, `src/extraction/languages/` | `web-tree-sitter`, WASM grammars |
| Database | SQLite backend, schema management | `src/db/`, `schema.sql` | `better-sqlite3` (optional), `node-sqlite3-wasm` |
| Resolution | Import + name + framework matching | `src/resolution/` | Tree-sitter output, file system |
| Graph | Query engine, traversal algorithms | `src/graph/` | Database |
| Context Builder | Format query results for agents | `src/context/` | Graph queries |
| MCP Server | Agent interface (Stdio transport) | `src/mcp/`, `server-instructions.ts` | Node.js |
| Installer | Multi-agent wiring | `src/installer/targets/` | Agent config file paths |
| CLI | Command-line interface | `src/bin/codegraph.ts` | All of the above |

---

## References

- **GitHub**: https://github.com/colbymchenry/codegraph
- **NPM**: https://www.npmjs.com/package/@colbymchenry/codegraph
- **Docs**: https://colbymchenry.github.io/codegraph/
- **License**: MIT
