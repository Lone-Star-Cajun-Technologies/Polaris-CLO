---
source: smartdocs/raw/2026-05-23-provider-capability-abstraction.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-06-04-013
classified-as: doctrine-candidate
linked-map-area: src/config
ingested-at: 2026-06-04T06:35:06.723Z
status: raw
---

# Provider Capability Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded GitNexus assumptions in Polaris taskchains with a capability-oriented `repo-analysis` provider abstraction so Polaris works portably in any environment.

**Architecture:** Taskchain MD files reference a `repo-analysis` capability instead of GitNexus by name. A new `providers.repoAnalysis` config section names the preferred provider and fallback chain. At runtime, steps check provider availability and fall back to `polaris map query` + ripgrep + direct file inspection when no provider is configured.

**Tech Stack:** TypeScript (config schema/validator), Markdown (taskchain skill files). No runtime changes to `polaris loop`, `polaris map`, or `polaris finalize`.

---

## File Map

### New files
- `docs/Polaris/spec/provider-capabilities.md` — architecture spec for capability/provider model
- `.codex/skills/polaris-analyze/linked-skills/repo-analysis.md` — replaces `gitnexus.md`
- `.codex/skills/polaris-run/linked-skills/repo-analysis.md` — replaces `gitnexus.md`
- `src/config/validator.test.ts` — unit tests for `providers` config validation

### Modified files
- `.codex/skills/polaris-analyze/SKILL.md` — remove GitNexus from description
- `.codex/skills/polaris-analyze/chain.md` — update linked-skills table + stop-condition wording
- `.codex/skills/polaris-analyze/steps/01-fetch-and-orient.md` — replace GitNexus freshness check with provider availability check
- `.codex/skills/polaris-analyze/steps/02-map-affected-code.md` — replace GitNexus-specific actions with capability-neutral actions + fallback path
- `.codex/skills/polaris-analyze/steps/06-final-report.md` — rename "GitNexus status" field
- `.codex/skills/polaris-run/chain.md` — update linked-skills table
- `.codex/skills/polaris-run/steps/01-orient-cluster.md` — rename skill in `allowed_skills`
- `.codex/skills/polaris-run/steps/02-prepare-branch.md` — rename skill in `allowed_skills`
- `.codex/skills/polaris-run/steps/03-select-child.md` — rename skill in `allowed_skills`
- `.codex/skills/polaris-run/steps/04-execute-child.md` — replace hardcoded "Use GitNexus" action
- `src/config/schema.ts` — add `providers.repoAnalysis` interface
- `src/config/defaults.ts` — add default `providers` value
- `src/config/validator.ts` — validate `providers` section + add "providers" to knownKeys

### Deleted files
- `.codex/skills/polaris-analyze/linked-skills/gitnexus.md`
- `.codex/skills/polaris-run/linked-skills/gitnexus.md`

---

## Task 1: Write the provider-capabilities spec doc

**Files:**
- Create: `docs/Polaris/spec/provider-capabilities.md`

- [ ] **Step 1: Create the spec file**

Write `docs/Polaris/spec/provider-capabilities.md` with this exact content:

```markdown
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
```

- [ ] **Step 2: Verify the file exists**

```bash
ls docs/Polaris/spec/provider-capabilities.md
```

Expected: file listed.

- [ ] **Step 3: Commit**

```bash
git add docs/Polaris/spec/provider-capabilities.md
git commit -m "docs: add provider-capabilities spec for repo-analysis abstraction"
```

---

## Task 2: Create new repo-analysis linked-skill files and delete old gitnexus.md files

**Files:**
- Create: `.codex/skills/polaris-analyze/linked-skills/repo-analysis.md`
- Create: `.codex/skills/polaris-run/linked-skills/repo-analysis.md`
- Delete: `.codex/skills/polaris-analyze/linked-skills/gitnexus.md`
- Delete: `.codex/skills/polaris-run/linked-skills/gitnexus.md`

- [ ] **Step 1: Create polaris-analyze repo-analysis linked-skill**

Write `.codex/skills/polaris-analyze/linked-skills/repo-analysis.md`:

```markdown
---
title: repo-analysis provider linkage
description: Provide targeted code intelligence when a repo-analysis provider is configured and available in the session environment.
version: "1.0"
---

# repo-analysis provider linkage

---

## Allowed steps

- 01-fetch-and-orient
- 02-map-affected-code

---

## Purpose

Provide targeted code intelligence when polaris-analyze needs to understand the affected code surface.

This linked-skill governs use of the configured repo-analysis provider (e.g., GitNexus). If no provider is available, the fallback path (polaris map query + ripgrep + direct file inspection) is authoritative. See `docs/Polaris/spec/provider-capabilities.md` for the full provider model.

---

## Allowed scope

- Check configured provider availability at session start
- Query specific files, symbols, or concepts relevant to the issue scope
- Run impact analysis on symbols mentioned in the issue
- Check provider index freshness and trigger refresh if stale
- Report execution flows relevant to the issue

---

## Forbidden scope

- Do not perform broad graph dumps or full-repo reports
- Do not replace direct repository inspection
- Do not invoke outside allowed steps
- Do not assume a specific provider product is present — check availability first

---

## Provider detection

At step 01, check `polaris.config.json` for `providers.repoAnalysis.preferred`.
If a provider is configured and available in the session environment: use it.
If unavailable or not configured: note `repo_analysis_status: not-configured` in artifact and proceed with fallback.

---

## Invocation note

Conditional. Invoke when the issue references specific files, symbols, or flows that benefit from graph context. When the provider is unavailable, the fallback path runs instead — the session continues either way.
```

- [ ] **Step 2: Create polaris-run repo-analysis linked-skill**

Write `.codex/skills/polaris-run/linked-skills/repo-analysis.md`:

```markdown
---
title: repo-analysis provider linkage
description: Provide targeted code intelligence and impact checks when a repo-analysis provider is configured and available in the session environment.
version: "1.0"
---

# repo-analysis provider linkage

---

## Allowed steps

- 01-orient-cluster
- 02-prepare-branch
- 03-select-child
- 04-execute-child

---

## Purpose

Provide targeted code intelligence and impact checks when polaris-run needs repository graph context.

This linked-skill governs use of the configured repo-analysis provider (e.g., GitNexus). If no provider is available, the fallback path (polaris map query + ripgrep + direct file inspection) is authoritative. See `docs/Polaris/spec/provider-capabilities.md` for the full provider model.

---

## Allowed scope

- Check configured provider availability at session start
- Query specific files, symbols, or concepts relevant to the current child
- Run impact analysis before modifying significant symbols
- Run targeted context checks to locate implementation surfaces
- Report stale-index warnings and pair them with direct inspection

---

## Forbidden scope

- Do not perform broad graph dumps or full-repo reports
- Do not replace direct repository inspection
- Do not expand implementation beyond the selected child
- Do not invoke outside allowed steps
- Do not assume a specific provider product is present — check availability first

---

## Provider detection

At step 01, check `polaris.config.json` for `providers.repoAnalysis.preferred`.
If a provider is configured and available in the session environment: use it.
If unavailable or not configured: note `repo_analysis_status: not-configured` in artifact and proceed with fallback.

---

## Invocation note

Conditional. Invoke only when a child requires code intelligence, symbol impact, or change-scope verification. When the provider is unavailable, the fallback path runs instead — execution continues.
```

- [ ] **Step 3: Delete the old gitnexus.md linked-skill files**

```bash
rm .codex/skills/polaris-analyze/linked-skills/gitnexus.md
rm .codex/skills/polaris-run/linked-skills/gitnexus.md
```

- [ ] **Step 4: Verify old files are gone and new files exist**

```bash
ls .codex/skills/polaris-analyze/linked-skills/
ls .codex/skills/polaris-run/linked-skills/
```

Expected: `caveman.md` and `repo-analysis.md` in each. No `gitnexus.md`.

- [ ] **Step 5: Commit**

```bash
git add .codex/skills/polaris-analyze/linked-skills/
git add .codex/skills/polaris-run/linked-skills/
git commit -m "refactor: replace gitnexus linked-skills with repo-analysis capability abstraction"
```

---

## Task 3: Update polaris-analyze SKILL.md and chain.md

**Files:**
- Modify: `.codex/skills/polaris-analyze/SKILL.md`
- Modify: `.codex/skills/polaris-analyze/chain.md`

- [ ] **Step 1: Update SKILL.md description and hard rules**

In `.codex/skills/polaris-analyze/SKILL.md`:

Change the frontmatter description (line 3):
```
description: Audit one Polaris issue against the actual repo using GitNexus and targeted inspection, then produce an ordered execution plan and cluster artifacts. Analysis and planning only — no code changes, no implementation execution.
```
→
```
description: Audit one Polaris issue against the actual repo using a configured repo-analysis provider (if available) and targeted inspection, then produce an ordered execution plan and cluster artifacts. Analysis and planning only — no code changes, no implementation execution.
```

Change the "may do" bullet:
```
- Query GitNexus for code intelligence
```
→
```
- Query the configured repo-analysis provider for code intelligence (if available; falls back to polaris map query + ripgrep)
```

- [ ] **Step 2: Update chain.md**

In `.codex/skills/polaris-analyze/chain.md`:

Change line 11 (step 01 description):
```
01-fetch-and-orient      ← parallel: Linear fetch + GitNexus freshness + run-start telemetry
```
→
```
01-fetch-and-orient      ← parallel: Linear fetch + repo-analysis provider check + run-start telemetry
```

Change line 12:
```
02-map-affected-code     ← targeted GitNexus inspection
```
→
```
02-map-affected-code     ← targeted repo-analysis inspection (provider or fallback)
```

Change the stop condition (line 28):
```
- HIGH or CRITICAL risk identified by GitNexus without a clear resolution path.
```
→
```
- HIGH or CRITICAL risk identified by repo-analysis provider without a clear resolution path.
```

Change the linked-skills table (line 72):
```
| gitnexus | 01, 02 | targeted lookup only |
```
→
```
| repo-analysis | 01, 02 | targeted lookup only; conditional on provider availability |
```

Change the never-compressed list (line 91):
```
- HIGH or CRITICAL GitNexus risk findings
```
→
```
- HIGH or CRITICAL repo-analysis provider risk findings
```

- [ ] **Step 3: Verify no "gitnexus" or "GitNexus" strings remain in either file**

```bash
grep -i "gitnexus" \
  .codex/skills/polaris-analyze/SKILL.md \
  .codex/skills/polaris-analyze/chain.md
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .codex/skills/polaris-analyze/SKILL.md \
        .codex/skills/polaris-analyze/chain.md
git commit -m "refactor(analyze): replace GitNexus assumptions with repo-analysis capability in SKILL.md and chain.md"
```

---

## Task 4: Update polaris-analyze step files

**Files:**
- Modify: `.codex/skills/polaris-analyze/steps/01-fetch-and-orient.md`
- Modify: `.codex/skills/polaris-analyze/steps/02-map-affected-code.md`
- Modify: `.codex/skills/polaris-analyze/steps/06-final-report.md`

- [ ] **Step 1: Update 01-fetch-and-orient.md**

Make these changes to `.codex/skills/polaris-analyze/steps/01-fetch-and-orient.md`:

**Frontmatter description** (line 3):
```
description: Generate run_id, emit run-start telemetry, activate caveman-lite, fetch the Linear issue and GitNexus freshness in parallel.
```
→
```
description: Generate run_id, emit run-start telemetry, activate caveman-lite, fetch the Linear issue and check repo-analysis provider availability in parallel.
```

**`allowed_skills`** (line 25):
```
  - gitnexus
```
→
```
  - repo-analysis
```

**`expected_evidence`** (line 31):
```
  - GitNexus freshness checked
```
→
```
  - repo-analysis provider status checked
```

**Action 3b** — replace lines 60–61:
```
   - Read `gitnexus://repo/{name}/context` and check the staleness warning.
     - If stale: run `npx gitnexus analyze` to refresh, then re-read.
```
→
```
   - Check `polaris.config.json` for `providers.repoAnalysis.preferred`.
     - If a provider is configured and available in the session environment:
       - Check provider index freshness. If stale: attempt refresh per provider's documented mechanism.
       - Record `repo_analysis_status: available` in artifact.
     - If not configured or unavailable:
       - Note: no repo-analysis provider available — polaris map query + direct inspection will be used in step 02.
       - Record `repo_analysis_status: not-configured` or `unavailable` accordingly.
```

**Artifact update field** (line 72):
```
- `gitnexus_status: fresh | stale | refreshed`
```
→
```
- `repo_analysis_status: available | unavailable | not-configured`
```

- [ ] **Step 2: Update 02-map-affected-code.md**

Make these changes to `.codex/skills/polaris-analyze/steps/02-map-affected-code.md`:

**Frontmatter description** (line 3):
```
description: Use GitNexus to map the files, symbols, and execution flows affected by the issue scope.
```
→
```
description: Use the configured repo-analysis provider (if available) or the fallback path to map the files, symbols, and execution flows affected by the issue scope.
```

**`allowed_files`** entry (line 18):
```
  - GitNexus query and context results for issue concepts
```
→
```
  - repo-analysis provider query results for issue concepts (when provider is available)
```

**`allowed_skills`** (line 23):
```
  - gitnexus
```
→
```
  - repo-analysis
```

**`stop_rules`** (line 30):
```
  - GitNexus result is stale and cannot be refreshed
```
→
```
  - repo-analysis provider result is stale and cannot be refreshed (only when provider is in use; if unavailable use fallback)
```

**Actions section** — replace lines 36–37:
```
1. Use GitNexus for targeted inspection only — query concepts relevant to the issue scope. Do not summarize the whole repo.
2. Use `gitnexus_impact` and `gitnexus_context` for specific symbols mentioned in the issue.
3. Inspect only files relevant to the issue scope.
4. Check the Polaris atlas (`polaris map query <path>`) for route and domain context on affected files.
5. Record the files and execution flows inspected.
```
→
```
1. Check `repo_analysis_status` from the step 01 artifact.
2. **If provider is available:** use it for targeted inspection only — query concepts relevant to the issue scope. Use impact analysis and context queries for specific symbols mentioned in the issue. Do not summarize the whole repo.
3. **If provider is unavailable (fallback path):**
   - Use `polaris map query <path>` for route/domain/taskchain context on affected files
   - Use `rg <symbol>` for symbol and pattern location across the repo
   - Use direct file inspection for implementation details
   - The fallback path is always sufficient to complete the analysis.
4. Always run `polaris map query <path>` for each affected file — it provides Polaris-specific routing context regardless of whether a provider is also in use.
5. Inspect only files relevant to the issue scope.
6. Record the files and execution flows inspected.
```

- [ ] **Step 3: Update 06-final-report.md**

In `.codex/skills/polaris-analyze/steps/06-final-report.md`, change line 37:
```
2. **GitNexus status** — fresh, stale, or refreshed
```
→
```
2. **Repo-analysis provider status** — `available` / `unavailable` / `not-configured` (if available: provider name and index freshness)
```

- [ ] **Step 4: Verify no "gitnexus" or "GitNexus" strings remain in these three files**

```bash
grep -i "gitnexus" \
  .codex/skills/polaris-analyze/steps/01-fetch-and-orient.md \
  .codex/skills/polaris-analyze/steps/02-map-affected-code.md \
  .codex/skills/polaris-analyze/steps/06-final-report.md
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add .codex/skills/polaris-analyze/steps/
git commit -m "refactor(analyze): replace GitNexus-specific steps with repo-analysis capability language"
```

---

## Task 5: Update polaris-run chain.md and step files

**Files:**
- Modify: `.codex/skills/polaris-run/chain.md`
- Modify: `.codex/skills/polaris-run/steps/01-orient-cluster.md`
- Modify: `.codex/skills/polaris-run/steps/02-prepare-branch.md`
- Modify: `.codex/skills/polaris-run/steps/03-select-child.md`
- Modify: `.codex/skills/polaris-run/steps/04-execute-child.md`

- [ ] **Step 1: Update polaris-run chain.md**

In `.codex/skills/polaris-run/chain.md`, change the linked-skills table row:
```
| gitnexus | 01, 02, 03, 04 | targeted lookup only |
```
→
```
| repo-analysis | 01, 02, 03, 04 | targeted lookup only; conditional on provider availability |
```

- [ ] **Step 2: Update 01-orient-cluster.md**

In `.codex/skills/polaris-run/steps/01-orient-cluster.md`, change `allowed_skills`:
```
  - gitnexus
```
→
```
  - repo-analysis
```

- [ ] **Step 3: Update 02-prepare-branch.md**

In `.codex/skills/polaris-run/steps/02-prepare-branch.md`, change `allowed_skills`:
```
  - gitnexus
```
→
```
  - repo-analysis
```

- [ ] **Step 4: Update 03-select-child.md**

In `.codex/skills/polaris-run/steps/03-select-child.md`, change `allowed_skills`:
```
  - gitnexus
```
→
```
  - repo-analysis
```

- [ ] **Step 5: Update 04-execute-child.md**

In `.codex/skills/polaris-run/steps/04-execute-child.md`:

Change `allowed_skills` entry:
```
  - gitnexus
```
→
```
  - repo-analysis
```

Change Action 3:
```
3. Use GitNexus for targeted file or symbol lookup only — not broad repo analysis.
```
→
```
3. If a repo-analysis provider is configured and available: use it for targeted file or symbol lookup only. Otherwise use `polaris map query` and direct file inspection. Do not perform broad repo analysis regardless of which path is used.
```

- [ ] **Step 6: Verify no "gitnexus" or "GitNexus" strings remain in any polaris-run file**

```bash
grep -ri "gitnexus" .codex/skills/polaris-run/
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add .codex/skills/polaris-run/
git commit -m "refactor(run): replace GitNexus-specific references with repo-analysis capability language"
```

---

## Task 6: Add `providers` to config schema, defaults, and validator (TDD)

**Files:**
- Create: `src/config/validator.test.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/validator.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/config/validator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { validateConfig } from "./validator.js";

describe("validateConfig — providers", () => {
  it("accepts config with no providers field", () => {
    const result = validateConfig({ version: "1.0" });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts empty providers object", () => {
    const result = validateConfig({ providers: {} });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts valid providers.repoAnalysis with preferred and fallback", () => {
    const result = validateConfig({
      providers: {
        repoAnalysis: {
          preferred: "gitnexus",
          fallback: ["polaris-map", "ripgrep"],
        },
      },
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts providers.repoAnalysis with only preferred", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts providers.repoAnalysis with only fallback", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: ["polaris-map"] } },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects providers that is not an object", () => {
    const result = validateConfig({ providers: "gitnexus" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("providers must be an object");
  });

  it("rejects providers.repoAnalysis that is not an object", () => {
    const result = validateConfig({ providers: { repoAnalysis: 42 } });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("providers.repoAnalysis must be an object");
  });

  it("rejects providers.repoAnalysis.preferred that is not a string", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: 123 } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.preferred must be a string",
    );
  });

  it("rejects providers.repoAnalysis.fallback that is not an array of strings", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: "polaris-map" } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.fallback must be an array of strings",
    );
  });

  it("rejects providers.repoAnalysis.fallback with non-string elements", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { fallback: [1, 2] } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "providers.repoAnalysis.fallback must be an array of strings",
    );
  });

  it("does not warn on the providers key", () => {
    const result = validateConfig({
      providers: { repoAnalysis: { preferred: "gitnexus" } },
    });
    expect(result.warnings).not.toContain('Unknown config field: "providers"');
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- --reporter=verbose src/config/validator.test.ts
```

Expected: all tests in the `providers` describe block fail (validator doesn't know about `providers` yet, so the unknown-field warning fires for the valid-config tests and the rejection tests don't fire).

- [ ] **Step 3: Add `providers` to the schema interface**

In `src/config/schema.ts`, add after the `integrations` block:

```typescript
  providers?: {
    repoAnalysis?: {
      preferred?: string;
      fallback?: string[];
    };
  };
```

The complete updated file:

```typescript
export interface PolarisConfig {
  version?: string;
  repo?: {
    name?: string;
    sourceRoots?: string[];
    docsRoots?: string[];
    taskchainRoots?: string[];
    generatedRoots?: string[];
    sidecarOutputPath?: string;
  };
  map?: {
    confidenceThreshold?: number;
    autoWriteAbove?: number;
    reviewRequiredBelow?: number;
    inferenceRules?: string[];
    onLowConfidence?: "warn" | "fail";
  };
  loop?: {
    bootstrapOutputPath?: string;
    analyzeImplBoundaryEnforced?: boolean;
    sessionTerminationMode?: "emit-marker" | "exit-0";
    allowBranchDivergence?: boolean;
  };
  finalize?: {
    targetBranch?: string;
    prDraft?: boolean;
    runChecks?: string[];
    requireMapValidation?: boolean;
    requireSchemaValidation?: boolean;
    archiveRunSnapshot?: boolean;
  };
  tracker?: {
    linear?: {
      enabled?: boolean;
      teamId?: string;
      projectId?: string;
    };
  };
  integrations?: {
    github?: {
      owner?: string;
      repo?: string;
    };
  };
  providers?: {
    repoAnalysis?: {
      preferred?: string;
      fallback?: string[];
    };
  };
}
```

- [ ] **Step 4: Add `providers` default value**

In `src/config/defaults.ts`, add after the `integrations` block:

```typescript
  providers: {
    repoAnalysis: {
      preferred: undefined as string | undefined,
      fallback: ["polaris-map", "ripgrep"],
    },
  },
```

The `DEFAULT_CONFIG` object becomes:

```typescript
import type { PolarisConfig } from "./schema.js";

export const DEFAULT_CONFIG: Required<PolarisConfig> = {
  version: "1.0",
  repo: {
    name: "",
    sourceRoots: ["src"],
    docsRoots: [],
    taskchainRoots: [],
    generatedRoots: [],
    sidecarOutputPath: ".polaris/map",
  },
  map: {
    confidenceThreshold: 0.75,
    autoWriteAbove: 0.85,
    reviewRequiredBelow: 0.75,
    inferenceRules: [],
    onLowConfidence: "warn",
  },
  loop: {
    bootstrapOutputPath: ".polaris/bootstrap",
    analyzeImplBoundaryEnforced: true,
    sessionTerminationMode: "emit-marker",
    allowBranchDivergence: false,
  },
  finalize: {
    targetBranch: "main",
    prDraft: true,
    runChecks: [],
    requireMapValidation: true,
    requireSchemaValidation: true,
    archiveRunSnapshot: true,
  },
  tracker: {
    linear: {
      enabled: false,
      teamId: "",
      projectId: "",
    },
  },
  integrations: {
    github: {
      owner: "",
      repo: "",
    },
  },
  providers: {
    repoAnalysis: {
      preferred: undefined as string | undefined,
      fallback: ["polaris-map", "ripgrep"],
    },
  },
};
```

- [ ] **Step 5: Add `providers` validation to validator.ts**

In `src/config/validator.ts`, add the providers validation block after the `integrations` block (before the `knownKeys` declaration):

```typescript
  // providers
  if ("providers" in config && config.providers !== undefined) {
    if (!isPlainObject(config.providers)) {
      result.valid = false;
      result.errors.push("providers must be an object");
    } else {
      if ("repoAnalysis" in config.providers && config.providers.repoAnalysis !== undefined) {
        if (!isPlainObject(config.providers.repoAnalysis)) {
          result.valid = false;
          result.errors.push("providers.repoAnalysis must be an object");
        } else {
          if (
            "preferred" in config.providers.repoAnalysis &&
            config.providers.repoAnalysis.preferred !== undefined
          ) {
            if (!isString(config.providers.repoAnalysis.preferred)) {
              result.valid = false;
              result.errors.push("providers.repoAnalysis.preferred must be a string");
            }
          }
          if (
            "fallback" in config.providers.repoAnalysis &&
            config.providers.repoAnalysis.fallback !== undefined
          ) {
            if (!isStringArray(config.providers.repoAnalysis.fallback)) {
              result.valid = false;
              result.errors.push(
                "providers.repoAnalysis.fallback must be an array of strings",
              );
            }
          }
        }
      }
    }
  }
```

Also add `"providers"` to the `knownKeys` Set:

```typescript
  const knownKeys = new Set([
    "version",
    "repo",
    "map",
    "loop",
    "finalize",
    "tracker",
    "integrations",
    "providers",
  ]);
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
npm test -- --reporter=verbose src/config/validator.test.ts
```

Expected: all tests in the `providers` describe block pass.

- [ ] **Step 7: Run the full test suite**

```bash
npm test
```

Expected: all tests pass. No regressions.

- [ ] **Step 8: Run lint and build**

```bash
npm run lint && npm run build
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/config/schema.ts src/config/defaults.ts src/config/validator.ts src/config/validator.test.ts
git commit -m "feat(config): add providers.repoAnalysis capability config with validation"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| Remove hardcoded GitNexus assumptions from generic Polaris taskchains | Tasks 2–5 |
| Replace with capability-oriented language (`repo-analysis`) | Tasks 2–5 |
| Preserve graceful fallback behavior | Tasks 3, 4 (step 02 fallback path preserved and made explicit) |
| Polaris still works in EVO environments where GitNexus is available | Tasks 3–5 (provider is used when configured; GitNexus named as example provider in spec) |
| Provider architecture extensible for future integrations | Task 1 (spec doc), Task 6 (config schema: `preferred` is a string, not an enum) |
| Config-driven provider mapping | Task 6 (`providers.repoAnalysis.preferred` + `fallback` array) |

**Placeholder scan:** No TBDs, TODOs, or "handle edge cases" phrases. All code blocks are complete.

**Type consistency:** 
- `repo_analysis_status` field name used consistently across step 01 artifact update and step 02 check.
- `providers.repoAnalysis.preferred` used consistently in spec doc, linked-skills files, and step action text.
- `validateConfig` function signature unchanged; new block follows identical pattern to existing `integrations` block.
