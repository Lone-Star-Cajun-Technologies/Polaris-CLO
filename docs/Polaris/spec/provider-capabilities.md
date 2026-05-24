# Polaris Provider Capabilities

**Status:** Active doctrine  
**Parent:** POL-42

---

## Purpose

Polaris is designed to be portable and vendor-neutral. It orchestrates repository understanding but does not own or require a specific understanding engine.

Capabilities describe what Polaris needs. Providers implement those capabilities.

---

## Capabilities

### repo-analysis

Provides code intelligence: symbol context, execution flow queries, impact analysis, and index freshness.

**Used by:** polaris-analyze (steps 01–02), polaris-run (steps 01–04)

**Required:** No. Polaris works without any provider. Provider availability is checked at session start and recorded in the run artifact.

---

## Providers

### gitnexus (optional)

Implements the `repo-analysis` capability via graph-backed queries.

Configure in `polaris.config.json`:
```json
{
  "providers": {
    "repoAnalysis": {
      "preferred": "gitnexus",
      "fallback": ["polaris-map", "ripgrep"]
    }
  }
}
```

### polaris-map (built-in fallback)

`polaris map query` is always available and serves as the first fallback for `repo-analysis`. It provides route/domain/taskchain context from the sidecar atlas.

### ripgrep (built-in fallback)

Pattern and symbol search via `rg`. Available in any environment with ripgrep installed. Second fallback after polaris-map.

### direct file inspection (baseline)

Direct `Read` and file system inspection. Always available. Third fallback.

---

## Provider Detection Protocol

At the start of any session that uses the `repo-analysis` capability:

1. Check `polaris.config.json` for `providers.repoAnalysis.preferred`.
2. If a preferred provider is named: verify it is available in the current session environment.
3. Record `repo_analysis_status` in the run artifact:
   - `available` — provider is configured and accessible
   - `unavailable` — provider is configured but not accessible in this environment
   - `not-configured` — no provider specified; fallback path is used
4. Proceed. All three statuses allow the session to continue. The provider enhances analysis quality; it is never a hard gate.

---

## Fallback Path

When no provider is available, steps use this sequence:

1. `polaris map query <path>` — route/domain/taskchain context
2. `rg <pattern> <path>` — symbol and pattern location
3. Direct file inspection — implementation details

The fallback path is always sufficient to complete analysis and implementation. Provider availability improves depth of code intelligence, not basic correctness.

---

## Adding a Future Provider

To add a new `repo-analysis` provider:

1. Choose a provider identifier (lowercase hyphenated, e.g., `tree-sitter-lsp`).
2. Document it in this spec under Providers.
3. Set it as `preferred` in `polaris.config.json` for the target repo.
4. The taskchain steps detect it via the `providers.repoAnalysis.preferred` config field and use it accordingly.

No changes to taskchain step logic are required — steps only check capability availability, not provider identity.
