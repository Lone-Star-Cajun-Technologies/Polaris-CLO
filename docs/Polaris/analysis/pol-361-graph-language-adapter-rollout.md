# POL-361: Graph Language Adapter Rollout Analysis

**Source issue:** POL-361  
**Follows:** POL-357 / PR #118 (multi-language graph adapter chassis)  
**Date:** 2026-06-06  
**Analyst run:** polaris-analyze-pol-361-2026-06-06-001

---

## Summary

POL-357 delivered the correct adapter architecture: `LanguageAdapter` interface, `AdapterRegistry`,
`GraphCapabilityRegistry`, extraction pipeline, and graceful file-level fallback. Only
TypeScript/JavaScript is covered today. This document defines the adapter rollout plan for the
remaining languages needed to provide real multi-language graph coverage across Polaris-managed repos.

---

## Adapter Interface (from POL-357)

```typescript
interface LanguageAdapter {
  languageId: string;
  fileExtensions: readonly string[];
  confidence: "high" | "medium" | "low";
  limitations: readonly string[];
  extractSymbols(filePath: string, source: string): Promise<AdapterExtractionResult>;
  resolveImportSpecifier(specifier: string, context: ImportResolutionContext): string | null;
}
```

Symbol kinds supported by the graph: `function`, `class`, `method`, `import` (plus `unknown` for
unclassified nodes). Node types: `FILE`, `SYMBOL`, `FUNCTION`, `CLASS`, `METHOD`, `IMPORT`.

The extraction pipeline (`src/graph/parser/pipeline.ts`) handles fallback automatically — files
without an adapter degrade to a `FILE` node, never silently disappear.

Tree-sitter binding: `tree-sitter ^0.21.1` (older Node.js binding API). Grammar packages use the
`tree-sitter-<lang>` naming convention and export native Node.js bindings via `bindings/node`.
The existing TypeScript adapter (`tree-sitter-typescript@0.23.2`) confirms this pattern works.

---

## Grammar Package Availability

| Language | npm Package | Version | Quality |
|---|---|---|---|
| Python | `tree-sitter-python` | 0.25.0 | High — well-maintained official grammar |
| Go | `tree-sitter-go` | 0.25.0 | High — well-maintained official grammar |
| Rust | `tree-sitter-rust` | 0.24.0 | High — well-maintained |
| Java | `tree-sitter-java` | 0.23.5 | High — complete coverage |
| C# | `tree-sitter-c-sharp` | 0.23.5 | High |
| C | `tree-sitter-c` | 0.24.1 | High — standard C grammar |
| C++ | `tree-sitter-cpp` | 0.23.4 | High |
| Dart | `tree-sitter-dart` | 1.0.0 | Medium-high — v1.0.0, stable |
| Svelte | `tree-sitter-svelte` | 0.11.0 | Medium — older; but delegation strategy mitigates gaps |
| Swift | `tree-sitter-swift` | 0.7.1 | Medium-low — older, possibly incomplete |
| Kotlin | `tree-sitter-kotlin` | 0.3.8 | Low-medium — older, possibly incomplete |

No `@tree-sitter/`-scoped packages exist for any of these languages. All use the unscoped naming.

---

## Per-Language Adapter Feasibility Notes

### Svelte

**File extensions:** `.svelte`  
**Parser strategy:** Delegation, not standalone Tree-sitter. Parse the `.svelte` file as text,
extract `<script>` and `<script lang="ts">` block contents, then delegate to the existing
`TypeScriptJavaScriptAdapter`.  
**Why:** `tree-sitter-svelte@0.11.0` is older and not well-maintained. The delegation approach
reuses the high-confidence TS/JS adapter for all actual logic, and has no dependency on a
questionable grammar package.  
**Component symbols:** Phase 1 — export the component name as a `class`-kind symbol derived from
the filename. No markup references in phase 1.  
**Script block handling:** Extract the raw content of `<script>` and `<script lang="ts">` blocks
using regex, then pass to the TS/JS adapter's extractSymbols.  
**Import handling:** Import statements inside `<script>` blocks are handled by the delegated TS/JS
extraction. No additional import graph edges needed in phase 1.  
**Confidence:** `medium` (delegation covers the real logic; markup-level symbols deferred).  
**Implementation complexity:** Low — no new tree-sitter grammar, pure text extraction + delegation.  
**Value:** High for Evo (Svelte is a primary frontend language).

### Dart / Flutter

**File extensions:** `.dart`  
**Parser strategy:** Tree-sitter via `tree-sitter-dart@1.0.0`.  
**Symbol kinds:** `class`, `function` (top-level functions), `method` (class methods), `import` (import directives).  
**Widgets:** Represent as `class`-kind symbols. Widget constructors are `method` symbols.  
**Import handling:** Dart import directives (`import 'package:...'` and `import '...'`). Resolve
package imports as external refs; relative imports via path resolution.  
**Flutter platform channels:** Phase 1 — not represented beyond class/method extraction. Follow-on
cluster can add platform bridge annotations.  
**Call extraction:** Deferred to a follow-on cluster.  
**Confidence:** `medium` (v1.0.0 grammar covers class/function/import; full semantic depth deferred).  
**Implementation complexity:** Medium — straightforward Tree-sitter adapter, standard pattern.  
**Value:** High for Evo (Flutter is a primary mobile framework).

### Swift

**File extensions:** `.swift`  
**Parser strategy:** Tree-sitter via `tree-sitter-swift@0.7.1`.  
**Symbol kinds:** `class`, `function` (free functions), `method` (class/struct/extension methods),
`import`.  
**Structs and protocols:** Represent as `class`-kind in phase 1 (the graph schema does not have a
`struct` or `protocol` kind; introduce aliases in the adapter).  
**Extensions:** Model the extension as adding methods to the `class`-kind symbol for the extended type.  
**Import handling:** `import Foundation`, `import UIKit`, etc. Treat module-level imports as external refs.  
**Platform bridge code:** Deferred.  
**Grammar risk:** `tree-sitter-swift@0.7.1` is older. May have incomplete coverage for newer Swift
syntax (async/await, macros). Phase 1 targets declaration-level symbols only, which should be stable.  
**Confidence:** `medium-low` — grammar age is a risk; recommend filing a follow-on issue to upgrade if
tree-sitter-swift maintenance improves.  
**Implementation complexity:** Medium-high — grammar risk means more fixture validation work.  
**Value:** Medium-high for Evo iOS targets.

### Kotlin / Java

**File extensions:** `.kt`, `.kts` (Kotlin); `.java` (Java)  
**Parser strategy:** Two separate adapters sharing a common extraction helper, or a single adapter
family. **Recommended:** single `kotlin-java` adapter family, registered as two `LanguageAdapter`
instances sharing extraction logic via shared helpers.  
**Symbol kinds:** `class` (classes, interfaces, objects), `function`/`method`, `import`.  
**Kotlin objects:** Represent as `class`-kind.  
**Android platform folders:** Model via normal file-level nodes for resource files (.xml, .gradle).
No special Android-folder logic in phase 1.  
**Kotlin/Java interop:** Not represented at symbol level in phase 1. The graph shows them as separate
files — cross-language call edges are a follow-on.  
**Grammar versions:** `tree-sitter-java@0.23.5` (high quality); `tree-sitter-kotlin@0.3.8` (older,
risky for newer Kotlin syntax). Phase 1 targets class/method/import — stable in older Kotlin grammar.  
**Confidence:** `medium` (Kotlin grammar is older; Java grammar is high quality).  
**Implementation complexity:** Medium — two adapters but shared logic; fixture work for Kotlin gaps.  
**Value:** High for Evo Android targets.

### Python

**File extensions:** `.py`, `.pyi`  
**Parser strategy:** Tree-sitter via `tree-sitter-python@0.25.0`.  
**Symbol kinds:** `class`, `function`, `method`, `import`.  
**Import handling:** `import foo`, `from foo import bar` — both produce `import`-kind symbols.  
**Confidence:** `high` — excellent grammar, stable API.  
**Implementation complexity:** Low — straightforward pattern, excellent grammar.  
**Value:** Medium-high (Polaris internal tooling, agent scripts).

### Go

**File extensions:** `.go`  
**Parser strategy:** Tree-sitter via `tree-sitter-go@0.25.0`.  
**Symbol kinds:** `function` (top-level funcs and methods), `class` (structs and interfaces mapped
to class-kind), `import`.  
**Import handling:** Go import blocks — `import "fmt"`, `import ( "net/http" )`.  
**Confidence:** `high` — excellent grammar.  
**Implementation complexity:** Low.  
**Value:** Medium (Polaris tooling, infra repos).

### Rust

**File extensions:** `.rs`  
**Parser strategy:** Tree-sitter via `tree-sitter-rust@0.24.0`.  
**Symbol kinds:** `function`, `class` (structs, enums, traits mapped to class-kind), `method`
(impl block functions), `import` (`use` declarations).  
**Confidence:** `high` — excellent grammar.  
**Implementation complexity:** Low-medium (impl blocks require slightly more tree walking).  
**Value:** Medium (Polaris tooling, systems repos).

### C / C++

**File extensions:** `.c`, `.h` (C); `.cpp`, `.cc`, `.cxx`, `.hpp` (C++)  
**Parser strategy:** Two adapters — `tree-sitter-c@0.24.1` and `tree-sitter-cpp@0.23.4`.  
**Symbol kinds:** `function`, `class` (structs, C++ classes), `method` (C++ class methods), `import`
(#include directives as import-kind).  
**Flutter context:** Flutter Windows runner uses C++ for the native shell. Providing function/class
extraction covers impact analysis for Windows runner changes.  
**Confidence:** `high` — both grammars are mature.  
**Implementation complexity:** Low-medium.  
**Value:** Medium (Windows Flutter targets, systems code).

### C# / .NET

**File extensions:** `.cs`  
**Parser strategy:** Tree-sitter via `tree-sitter-c-sharp@0.23.5`.  
**Symbol kinds:** `class`, `method`, `function` (static methods), `import` (using directives).  
**Confidence:** `high` — mature grammar.  
**Implementation complexity:** Low.  
**Value:** Medium (Windows .NET Flutter runner, platform code).

### Shell Scripts

**File extensions:** `.sh`, `.bash`, `.zsh`  
**Parser strategy:** `tree-sitter-bash` is available on npm but not checked here. Alternatively,
a lightweight line-scanning approach (function definitions via regex) is simpler and adequate for
phase 1 since shell scripts rarely need symbol-level impact analysis.  
**Recommendation:** Regex-based function extraction (not tree-sitter) for phase 1. Ship in Tier 3.  
**Confidence:** `low` (regex only; limited impact analysis value).  
**Implementation complexity:** Low.

### YAML / JSON / TOML Config

**File extensions:** `.yaml`, `.yml`, `.json`, `.toml`  
**Parser strategy:** Not tree-sitter. These files contribute dependency edge information, not symbol
graphs. Model as `FILE`-level nodes that carry dependency-edge metadata (e.g., package.json
dependencies, pubspec.yaml deps, Gradle dependencies).  
**Scope:** The current graph schema does not have a `DEPENDS_ON` edge type. Phase 1 treats config
files as `FILE`-level nodes (already handled by the fallback). A follow-on issue can add config
dependency edges to the schema.  
**Recommendation:** No new adapter in Cluster 1. Document as a future cluster. The fallback
already handles these files safely.

### Markdown / SmartDocs

**Recommendation:** Not in phase 1 rollout. SmartDocs route-graphing is a distinct concern from
symbol-level code impact analysis. File-level fallback is adequate.

---

## Proposed Adapter Interface Changes

No breaking interface changes are required. The existing `LanguageAdapter` interface covers all
planned adapters. One non-breaking addition is recommended:

- **`symbolKindMap`** (optional, informational) — a static map from adapter-specific symbol
  categories to `GraphSymbolKind`. Already implicit in each adapter's extract logic. Not a
  required interface change; can be internal to each adapter.

---

## Proposed Test Fixture Strategy

Each new adapter needs:

1. **Unit fixtures per language** — `.fixture.<ext>` files in `src/graph/adapter/<name>/fixtures/`
   containing representative syntax: class declaration, function/method, import, edge cases.
2. **Mixed-language fixture repo** — a directory under `src/graph/adapter/__fixtures__/mixed-repo/`
   containing files from multiple languages to exercise the registry dispatch and coverage report.
3. **CLI smoke tests** — `npm run polaris -- graph build` against the fixture repo; verify coverage
   report includes all registered language IDs and no silent file disappearance.

---

## Proposed Mixed-Language Validation Fixture Layout

```plaintext
src/graph/adapter/__fixtures__/mixed-repo/
  sample.ts
  sample.js
  sample.py
  sample.go
  sample.rs
  sample.dart
  sample.swift
  sample.kt
  sample.java
  sample.cs
  sample.cpp
  sample.svelte
  pubspec.yaml        (falls back to file-level)
  package.json        (falls back to file-level)
```

Assertions:
- Coverage report includes each registered language ID
- No file silently absent from the graph (all appear at FILE or symbol level)
- Symbol counts per language > 0 for all symbol-level adapters
- Fallback count matches unsupported file count

---

## Risks and Limitations

| Risk | Severity | Mitigation |
|---|---|---|
| `tree-sitter-kotlin@0.3.8` grammar completeness | Medium | Phase 1 targets class/method/import only; add grammar-version check to README; file follow-on to upgrade if better grammar ships |
| `tree-sitter-swift@0.7.1` grammar completeness | Medium | Same mitigation; async/await/macros deferred; file follow-on |
| `tree-sitter 0.21.1` compatibility with newer grammar packages (0.24–0.25) | Medium | The existing `tree-sitter-typescript@0.23.2` already confirms the loading pattern works; all grammar packages expose the same `bindings/node` native addon API |
| Svelte `<script>` edge cases (multiple blocks, lang attribute variants) | Low | Regex extraction tested against svelte docs; fallback to empty symbols if no script block found |
| Symbol kind mapping for non-OOP languages (Go structs, Rust enums) | Low | Map to `class`-kind as documented; limitation declared in adapter; no schema change needed |

---

## Recommended Adapter Priority Order

1. **Svelte** — Immediate Evo value, lowest implementation risk (delegation pattern)
2. **Dart** — Immediate Evo value, good grammar, straightforward
3. **Kotlin/Java** — Immediate Evo Android value; Java grammar excellent, Kotlin acceptable for phase 1
4. **Swift** — Evo iOS value; grammar risk is manageable for declaration-level symbols
5. **Python / Go / Rust** — Common tooling repos; all high-quality grammars, low complexity
6. **C / C++ / C#** — Windows platform coverage; mature grammars; lower urgency for Evo

---

## Recommended Cluster Structure

Budget: `max_children: 6` per config.

**IMPLEMENT parent:** IMPLEMENT: Multi-language graph adapter rollout (6 children)

| Cluster | Title | Languages | Priority |
|---|---|---|---|
| C-01 | Svelte graph adapter | Svelte | 1 |
| C-02 | Dart adapter | Dart/Flutter | 2 |
| C-03 | Kotlin and Java adapters | Kotlin, Java | 3 |
| C-04 | Swift adapter | Swift | 4 |
| C-05 | Python, Go, and Rust adapters | Python, Go, Rust | 5 |
| C-06 | C, C++, C#, and shell adapters | C, C++, C#, shell | 6 |

Execution sequence: C-01 → C-02 → C-03 → C-04 → C-05 → C-06 (serial, each is independent but
priority order reflects Evo criticality).

---

## Follow-on Clusters (post-rollout)

After all 6 clusters ship:
- **Config dependency edges** — extend graph schema with `DEPENDS_ON` edge type; add config-file
  adapter that emits dependency edges from package.json, pubspec.yaml, Gradle, etc.
- **Mixed-language call edges** — cross-language impact analysis (Kotlin/Java interop, Swift/ObjC bridges)
- **Grammar upgrades** — upgrade Kotlin and Swift grammars when better versions ship
- **SmartDocs route graph** — Markdown/SmartDocs references as route graph edges

---

## Success Criteria

- After all 6 clusters: coverage report shows symbol-level extraction for TS/JS, Dart, Swift,
  Kotlin, Java, C, C++, C#, Python, Go, Rust, Svelte.
- Unsupported-language fallback remains intact and explicit.
- No silent file disappearance.
- The next cluster (C-01) can start immediately — no re-architecture needed.
