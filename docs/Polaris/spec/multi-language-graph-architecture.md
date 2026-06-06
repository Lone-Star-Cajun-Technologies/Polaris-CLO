# Multi-Language Graph Extraction and Resolver Architecture

**Source issue:** POL-356
**Analyst run:** polaris-analyze-multi-lang-graph-arch-2026-06-06-001
**Date:** 2026-06-06

---

## 1. Recommended Multi-Language Graph Architecture

The Polaris graph system should adopt a three-layer model:

```
┌─────────────────────────────────────────┐
│           Language-Neutral Core          │
│  store / query / governance / CLI        │
├─────────────────────────────────────────┤
│          Language Adapter Layer          │
│  adapter registry + per-language impls  │
├─────────────────────────────────────────┤
│         Graph Capability Registry        │
│  coverage reporting / degradation state  │
└─────────────────────────────────────────┘
```

### Layer 1: Language-Neutral Core (keep as-is)

The following subsystems are already language-neutral and should not change:

- `src/graph/store/` — SQLite schema (`files`, `nodes`, `symbols`, `edges`), adapter, and query helpers. The `language` column on the `files` table is a free string — it imposes no schema constraint on which languages are valid.
- `src/graph/query/` — symbol lookup, callers/callees, impact traversal, and stats APIs. All operate on generic graph primitives.
- `src/graph/governance.ts` — config hash + HEAD commit invalidation triggers. Language-agnostic.
- `src/cli/graph.ts` command wiring — the overall build/query/impact surface is correct. Only the hardcoded `SUPPORTED_SOURCE_EXTENSIONS` set needs to be replaced with adapter-registry delegation.

### Layer 2: Language Adapter Layer (refactor targets)

The following subsystems need refactoring into an adapter interface:

- `src/graph/parser/loader.ts` — hardcoded `SupportedParserLanguage = "typescript" | "javascript"` union. Replace with a pluggable adapter registry.
- `src/graph/parser/extract.ts` — Tree-sitter node type matching uses TS/JS-specific node names (`function_declaration`, `method_definition`, etc.). Migrate into a TypeScript/JavaScript adapter.
- `src/graph/parser/pipeline.ts` — `detectSupportedLanguage()` hardcodes TS/JS extensions. Replace with adapter registry dispatch. Update unsupported-file path to produce file-level nodes instead of warnings-only.
- `src/graph/resolver/resolve-imports.ts` — `resolveImportSpecifier()` hardcodes TS/JS extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`). Import resolution should be delegatable to adapters.
- `src/graph/resolver/build-edges.ts` — `extractCallNames()` uses regex over function signature text (not AST call-expression nodes). This is TS/JS-biased and known to miss many call patterns. Keep for phase 1 but flag as a per-adapter concern going forward.

### Layer 3: Graph Capability Registry (new)

A new `GraphCapabilityRegistry` tracks extraction outcomes per language and exposes a structured coverage report. See Section 3 for the interface shape.

---

## 2. Proposed Language Adapter Interface

```typescript
/** Unique language identifier. Use lowercase hyphenated names (e.g. "typescript-javascript", "dart-flutter"). */
type LanguageId = string;

/** Confidence level for symbol extraction. "symbol-level" means functions/classes are extracted. */
type ExtractionConfidence = "symbol-level" | "file-level-only";

interface LanguageAdapter {
  /** Unique identifier for this adapter. */
  readonly languageId: LanguageId;

  /** File extensions handled by this adapter (e.g. [".ts", ".tsx", ".js"]). */
  readonly fileExtensions: string[];

  /**
   * Confidence level of symbol extraction.
   * symbol-level: functions, classes, methods, imports extracted.
   * file-level-only: adapter only registers the file; no symbol extraction.
   */
  readonly confidence: ExtractionConfidence;

  /** Short human-readable description of known limitations. */
  readonly limitations: string[];

  /**
   * Extract symbols from a source file.
   * Returns an empty symbols array if confidence is file-level-only.
   */
  extractSymbols(source: string, filePath: string): Promise<ExtractedFileSymbols>;

  /**
   * Resolve an import specifier from a given importer path.
   * Return the resolved absolute path, or null if resolution is not possible.
   * Receives the full set of files in the graph for lookup.
   */
  resolveImportSpecifier(
    specifier: string,
    importerPath: string,
    filesByPath: Map<string, string>,
  ): string | null;
}

interface AdapterRegistry {
  register(adapter: LanguageAdapter): void;
  getForExtension(ext: string): LanguageAdapter | null;
  getSupportedExtensions(): string[];
  getAll(): LanguageAdapter[];
}
```

Each adapter resides in `src/graph/adapter/<language-id>/index.ts` and is registered at pipeline initialization. The TypeScript/JavaScript adapter is the migration of the existing `extract.ts` and `loader.ts` logic.

---

## 3. Proposed Graph Capability Registry Shape

```typescript
interface LanguageCoverageEntry {
  /** Number of files discovered with this language's extensions. */
  filesDiscovered: number;
  /** Files successfully extracted at symbol level. */
  filesSymbolLevel: number;
  /** Files registered at file level only (no symbol extraction). */
  filesFileLevel: number;
  /** Files that failed extraction (error during parse). */
  filesFailed: number;
  /** Total symbols extracted. */
  symbolsExtracted: number;
  /** Adapter-emitted warnings for this language. */
  warnings: string[];
}

interface GraphCapabilityReport {
  /** All languages for which an adapter is registered. */
  supportedLanguages: LanguageId[];
  /** Per-language extraction outcomes. */
  coverage: Record<LanguageId, LanguageCoverageEntry>;
  /** File extensions discovered that have no registered adapter. */
  unsupportedExtensions: string[];
  /** Count of files that had no adapter and received file-level fallback nodes. */
  fallbackFileCount: number;
  /** Percentage of discovered files with symbol-level coverage (0–100). */
  symbolLevelPercent: number;
  /** Percentage of discovered files with at least file-level coverage (0–100). */
  totalCoveragePercent: number;
}
```

This report is attached to `ExtractionPipelineResult` and surfaced in:
- `graph build` JSON output under `extraction.capability`
- `graph build` text output as a per-language coverage table
- Available to Analyst context planning and Medic route exams (future integration)

---

## 4. Recommended Language Support Tiers

Tier assignments are based on Tree-sitter grammar maturity, npm availability, and Polaris/Evo relevance.

### Tier 1 — Symbol-level extraction via Tree-sitter (immediate value)

| Language | Grammar Package | Notes |
|---|---|---|
| TypeScript / JavaScript | `tree-sitter` + `@tree-sitter/typescript` + `@tree-sitter/javascript` | Already implemented |
| Python | `tree-sitter-python` | Mature grammar, common in tooling repos |
| Go | `tree-sitter-go` | Mature grammar |
| Rust | `tree-sitter-rust` | Mature grammar |

### Tier 2 — Symbol-level extraction via Tree-sitter (Evo-priority languages)

| Language | Grammar Package | Notes |
|---|---|---|
| Kotlin / Java | `tree-sitter-kotlin`, `tree-sitter-java` | Android targets in Evo |
| Dart / Flutter | `tree-sitter-dart` | Flutter targets in Evo |
| Swift | `tree-sitter-swift` | iOS targets in Evo |
| Svelte | `tree-sitter-svelte` | Web targets in Evo |
| C# | `tree-sitter-c-sharp` | Windows targets in Evo |

### Tier 3 — File-level only (no symbol extraction)

| Language | Approach | Notes |
|---|---|---|
| C / C++ | File-level fallback | `tree-sitter-c` / `tree-sitter-cpp` exist but call graphs are complex; file-level is safer for phase 1 |
| Shell scripts | File-level fallback | `tree-sitter-bash` exists; call graph semantics are complex |
| YAML / JSON / config | File-level reference edges | Dependency edges only; no symbol extraction |
| Markdown | File-level reference edges | Route/doc reference edges only |

**Revision to issue's tier proposal:**
The issue placed Python, C#, C/C++, Go, and Rust in Tier 2 ("Common Repo Coverage"). Given that Python, Go, and Rust have the most mature tree-sitter grammars on npm, they move to Tier 1 for symbol-level coverage. The Evo-specific languages (Kotlin, Dart, Swift, Svelte, C#) form Tier 2 because Polaris needs them but they require more integration work and testing.

---

## 5. Recommended Fallback Behavior for Unsupported Languages

When no adapter is registered for a file's extension, the pipeline must not silently skip the file.

**Required behavior:**
1. Create a `FILE` node in the graph store with `language = "unsupported:<ext>"` (e.g. `"unsupported:.swift"` before a Swift adapter is registered).
2. Attach a `PARTIAL_COVERAGE` flag in node metadata: `{ "partialCoverage": true, "reason": "no-adapter" }`.
3. Register the file in `GraphCapabilityReport.fallbackFileCount` and `unsupportedExtensions`.
4. Do not create symbol nodes or edges for the file.
5. Emit a capability warning: `"File <path> has no adapter — registered at file level only"`.

**What this prevents:**
- Impact analysis falsely reporting "no affected files" for a language simply because no adapter exists.
- Medic route exams overtrusting graph coverage.
- Librarian summaries missing file context for unsupported-language files.

**What this does NOT guarantee:**
- Symbol-level impact for unsupported files. Cross-file impact traversal stops at file-level nodes.
- Any call or import edge resolution for unsupported files.

Routing and dispatch must treat missing symbols in unsupported-language files as "impact unknown, not impact absent."

---

## 6. Recommended Graph Coverage Reporting Model

The `graph build` command should emit a coverage report at the end of every build.

**Text output (existing build summary expanded):**

```
Graph Build — Coverage Report
─────────────────────────────
Language              Files    Symbol-Level    File-Level    Failed
typescript              142          142             0           0
javascript               18           18             0           0
unsupported:.svelte      12             0            12           0
unsupported:.dart         8             0             8           0
─────────────────────────────
Total                   180          160            20           0
Symbol-level coverage:  88.9%
Total file coverage:   100.0%
```

**JSON output (`extraction.capability` field added to existing JSON):**

```json
{
  "extraction": {
    "processedFiles": 180,
    "succeededFiles": 160,
    "failedFiles": 0,
    "capability": {
      "supportedLanguages": ["typescript-javascript"],
      "unsupportedExtensions": [".svelte", ".dart"],
      "fallbackFileCount": 20,
      "symbolLevelPercent": 88.9,
      "totalCoveragePercent": 100.0,
      "coverage": {
        "typescript-javascript": {
          "filesDiscovered": 160,
          "filesSymbolLevel": 160,
          "filesFileLevel": 0,
          "filesFailed": 0,
          "symbolsExtracted": 1847,
          "warnings": []
        }
      }
    }
  }
}
```

This model allows Analyst and Medic to interpret graph coverage with explicit confidence bounds.

---

## 7. Recommended Cross-Language Edge Model

### Phase 1 (this cluster): File-level import edges only

Cross-language edges in phase 1 are restricted to file-level `IMPORTS` edges. Example: a Svelte component that imports a TypeScript helper will produce a file → file `IMPORTS` edge once both files have adapters registered.

Resolution approach: each adapter's `resolveImportSpecifier()` is called for its language's import forms. If the resolved path matches a file registered by a different adapter, the edge is created as a cross-language file-level edge.

Edge metadata should include `{ "crossLanguage": true, "fromLanguage": "svelte", "toLanguage": "typescript-javascript" }`.

### Phase 2 (future): Known bridge patterns

Certain cross-language relationships follow predictable patterns that can be modeled as first-class edges:

| Pattern | From | To | Edge strategy |
|---|---|---|---|
| Flutter platform channel | Dart | Swift / Kotlin | Detect `MethodChannel` calls; create advisory edges to platform runner files |
| Svelte `<script>` imports | Svelte | TypeScript | Standard relative import resolution |
| iOS Flutter bridge | Dart | Swift `AppDelegate` | Advisory edge from Flutter entry to platform runner |
| Android Flutter bridge | Dart | Kotlin `MainActivity` | Advisory edge from Flutter entry to platform runner |

Phase 2 edges should be tagged `advisory: true` in metadata to distinguish them from resolved edges.

### What to NOT model (for now)

- C# / C++ Windows platform bridge (complex, low ROI for phase 1)
- Type-level cross-language relationships
- FFI or native extension bindings

---

## 8. Assessment of PR #115 Reusable Core vs Refactor Targets

### Reusable as permanent language-neutral core — no changes required

| File | Assessment |
|---|---|
| `src/graph/store/schema.sql` | Fully language-neutral. The `files.language` column is a free string. Keep as-is. |
| `src/graph/store/types.ts` | Fully language-neutral. `GraphNodeType`, `GraphEdgeType`, `GraphSymbolKind` are correct. Keep as-is. |
| `src/graph/store/adapter.ts` | Language-neutral DB adapter. Keep as-is. |
| `src/graph/store/queries.ts` | Language-neutral insert/lookup helpers. Keep as-is. |
| `src/graph/query/index.ts` | Language-neutral query API. Keep as-is. |
| `src/graph/query/types.ts` | Language-neutral response types. Keep as-is. |
| `src/graph/governance.ts` | Language-neutral governance and invalidation. Keep as-is. |
| `src/graph/resolver/index.ts` | Orchestration layer is language-neutral. Keep with minor update to pass adapter registry to import resolver. |
| `src/graph/resolver/build-edges.ts` | Edge construction logic is largely language-neutral. `extractCallNames()` regex is TS-biased but acceptable for phase 1; flag as adapter-specific in follow-on clusters. Keep with minimal changes. |

### Refactor targets — migrate to adapter layer

| File | Required change |
|---|---|
| `src/graph/parser/loader.ts` | Replace hardcoded `SupportedParserLanguage = "typescript" \| "javascript"` with adapter registry. Move Tree-sitter loading into the TS/JS adapter. |
| `src/graph/parser/extract.ts` | Move into `src/graph/adapter/typescript-javascript/extract.ts`. No logic changes needed — only relocation. |
| `src/graph/parser/pipeline.ts` | Replace `detectSupportedLanguage()` with adapter registry dispatch. Add file-level fallback path for unsupported extensions. |
| `src/graph/resolver/resolve-imports.ts` | Make `resolveImportSpecifier()` delegatable: call the adapter's resolver for the importer file's language, fall back to null for unrecognized specifier forms. |
| `src/cli/graph.ts` | Replace `SUPPORTED_SOURCE_EXTENSIONS` constant with `registry.getSupportedExtensions()` at runtime. |

### Additional finding: call extraction accuracy

`extractCallNames()` in `build-edges.ts` uses regex pattern matching over function signature text (not AST call-expression nodes). This produces false positives (e.g. `if(`, `for(`) — partially mitigated by `RESERVED_CALL_TOKENS` — and false negatives (method chains, property access calls, calls in nested scopes not in the signature text). This is a known limitation even for TypeScript. AST-based call-expression extraction would be more accurate but is deferred to a future cluster. For phase 1, the regex approach is acceptable and produces useful (if imperfect) CALLS edges.

---

## 9. Minimum Validation Commands for Real Graph Readiness

The following commands must succeed before graph data can be trusted for Evo-style multi-language repos:

```bash
# Build passes cleanly
npm run build

# All tests pass
npm test
npx vitest run src/graph/

# Dry-run shows correct file discovery (extensions from adapter registry, not hardcoded)
npm run polaris -- graph build --dry-run --json

# Real build runs without failures
npm run polaris -- graph build --json

# Build output includes capability report with language breakdown
# Verify: "capability" key present, "unsupportedExtensions" lists non-TS/JS files
npm run polaris -- graph build --json | jq '.extraction.capability'

# Symbol lookup returns results
npm run polaris -- graph query <known-function-name>

# Impact returns results for a known symbol
npm run polaris -- graph impact <known-function-name>
```

Graph data should be considered advisory (not authoritative) until:
1. At least one non-TypeScript/JavaScript adapter is registered and validated
2. Capability report shows `totalCoveragePercent >= 90` for the target repo
3. `fallbackFileCount` is reported explicitly (not silently 0 due to skipping)

---

## 10. Risks and Limitations

| Risk | Severity | Mitigation |
|---|---|---|
| Tree-sitter grammar package availability on npm | Medium | Some grammars require building from source or are only available as WASM. Verify each Tier 1/2 grammar before committing to it. |
| WASM vs native tree-sitter | Low (for CLI) | The current loader uses native Node.js bindings. WASM is needed only for browser environments. CLI use is not affected. |
| `extractCallNames()` accuracy | Medium | Regex-based call extraction misses many patterns. This is an accepted limitation for phase 1. Flag clearly in capability report. |
| Cross-language resolution complexity | High | Platform bridges (Dart↔Swift, Dart↔Kotlin) are hard to model reliably. Phase 1 should make no promises about cross-language call edges. |
| Performance on large repos | Medium | Running multiple Tree-sitter parsers in sequence is CPU-intensive. Parallel extraction or incremental builds may be needed for repos like Evo. |
| Silent degradation risk after refactor | Low | The refactor must preserve all existing TS/JS extraction behavior exactly. Run `npx vitest run src/graph/` before and after to verify no regressions. |
| Adapter registry not yet typed at compile time | Low | The adapter registry is open (accepts any LanguageAdapter). Type safety is achieved through the interface contract, not exhaustive union types. |

---

## 11. Proposed Next IMPLEMENT Cluster

### Parent: "IMPLEMENT: Multi-language graph adapter architecture"

Scope:
- `src/graph/adapter/**`
- `src/graph/parser/loader.ts`, `src/graph/parser/extract.ts`, `src/graph/parser/pipeline.ts`
- `src/graph/resolver/resolve-imports.ts`
- `src/cli/graph.ts`

Acceptance criteria (cluster-level):
- LanguageAdapter interface defined and TypeScript/JavaScript logic migrated into an adapter
- Adapter registry drives file extension detection in the pipeline
- Unsupported language files produce file-level graph nodes (not silent skips)
- GraphCapabilityRegistry tracks and reports coverage by language
- `graph build` output includes a coverage report
- All existing TS/JS extraction behavior preserved exactly
- `npm run build`, `npm test`, `npx vitest run src/graph/` pass

### Child 1: LanguageAdapter interface and TypeScript/JavaScript adapter migration

**Scope:**
- `src/graph/adapter/types.ts` (new)
- `src/graph/adapter/registry.ts` (new)
- `src/graph/adapter/typescript-javascript/` (new — migrated from `parser/loader.ts` and `parser/extract.ts`)
- `src/graph/parser/loader.ts` (refactor)
- `src/graph/parser/extract.ts` (refactor — migrate logic, keep file as thin re-export or remove)
- `src/graph/parser/extract.test.ts` (update imports)
- `src/cli/graph.ts` (update `SUPPORTED_SOURCE_EXTENSIONS` → registry)

**Objective:** Define the `LanguageAdapter` interface and `AdapterRegistry`. Migrate existing TypeScript/JavaScript extraction logic into `src/graph/adapter/typescript-javascript/`. Update `pipeline.ts` to dispatch via registry. Replace the `SUPPORTED_SOURCE_EXTENSIONS` constant in `graph.ts` with `registry.getSupportedExtensions()`.

**Ordering:** No dependencies — executes first.

### Child 2: File-level graceful degradation for unsupported languages

**Scope:**
- `src/graph/parser/pipeline.ts`

**Objective:** Update the extraction pipeline's unsupported-file path. Instead of emitting a warning and continuing to the next file, create a `FILE` node in the graph store with `language = "unsupported:<ext>"` and `{ partialCoverage: true, reason: "no-adapter" }` node metadata. Ensure the resolver handles file-level-only nodes correctly (no symbol edge attempts).

**Ordering:** Depends on Child 1 (adapter registry must exist to determine "unsupported").

### Child 3: GraphCapabilityRegistry and graph build coverage report

**Scope:**
- `src/graph/capability/index.ts` (new)
- `src/graph/parser/pipeline.ts` (extend result type)
- `src/cli/graph.ts` (extend JSON output and text summary)

**Objective:** Implement `GraphCapabilityRegistry` that accumulates coverage data during extraction. Attach `GraphCapabilityReport` to `ExtractionPipelineResult`. Extend `graph build` CLI output to include a per-language coverage table in text mode and a `capability` field in JSON mode.

**Ordering:** Depends on Child 1 and Child 2 (needs adapter registry for supported languages list and file-level fallback counts).
