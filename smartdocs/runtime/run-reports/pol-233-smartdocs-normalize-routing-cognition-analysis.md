---
source-issue: POL-233
doc-type: analysis
status: raw
created: 2026-05-30
source: smartdocs/raw/pol-233-smartdocs-normalize-routing-cognition-analysis.md
ingest-run-id: polaris-docs-ingest-docs-ingest-2026-06-04-011
classified-as: run-report
linked-map-area: src/cognition
ingested-at: 2026-06-04T06:23:13.190Z
---

# POL-233 Analysis: Normalize SmartDocs Routing, Folder Cognition, YAML Links, and Telemetry Cleanup

> **Issue:** POL-233 — ANALYZE: Normalize SmartDocs routing, folder cognition, YAML links, and telemetry cleanup
> **Run:** polaris-analyze-smartdocs-normalize-routing-cognition-2026-05-30-001

---

## 1. Current-State Inventory

### 1.1 SmartDocs Path Surface

The canonical documentation vault is at `smartdocs/` (Obsidian vault root). All content lives one level deeper under `smartdocs/docs/`:

```text
smartdocs/
├── .obsidian/          ← Obsidian vault config (5 files)
└── docs/               ← CANONICAL_TARGET in ingest.ts
    ├── architecture/   (7 files)
    ├── audits/         (findings/, resolved/)
    ├── decisions/      (empty)
    ├── doctrine/       (active/ 6 files, candidate/ 4 files, deprecated/ empty)
    ├── integrations/   (2 files)
    ├── raw/            (17 files — ingest staging area)
    ├── runtime/        (generated/, run-reports/, summaries/)
    └── specs/          (active/ 26 files, implemented/ empty, superseded/ empty)
```

**Key path constants hardcoded across the codebase:**

| File | Hardcoded path |
|------|---------------|
| `src/smartdocs-engine/ingest.ts:73` | `CANONICAL_TARGET = "smartdocs/docs"` |
| `src/smartdocs-engine/doctrine.ts:128,139` | `smartdocs/docs/raw/`, `smartdocs/docs/doctrine/candidate/` |
| `src/smartdocs-engine/doctrine.ts:172,208` | `smartdocs/docs/doctrine/candidate/`, `active/` |
| `src/smartdocs-engine/doctrine.ts:274,279` | `smartdocs/docs/doctrine/active/`, `deprecated/` |
| `src/smartdocs-engine/doctrine.ts:369,373` | `smartdocs/docs/raw/`, `smartdocs/docs/specs/active/` |
| `src/smartdocs-engine/migrate.ts:143,221` | `smartdocs/docs/raw/` |
| `src/smartdocs-engine/smartdoc-ignore.ts:13–21` | `smartdocs/docs/doctrine/**`, `smartdocs/docs/specs/**`, etc. |
| `src/skill-packet/index.ts:21` | `smartdocs/docs/raw/` |
| `src/skill-packet/generator.ts:110–126` | `smartdocs/docs/raw/`, `smartdocs/docs/` |
| `src/cognition/summary-delta.ts:29,87` | `smartdocs/docs/doctrine/active/` |
| `src/smartdocs-engine/POLARIS.md` | references `smartdocs/docs/` throughout |
| `smartdocs/docs/doctrine/active/smartdocs-summary-architecture.md` | `smartdocs/docs/doctrine/active/` |

**Total `smartdocs/docs/` references in src/:** 22 occurrences across 9 non-test files.

### 1.2 Folder Cognition Coverage

**POLARIS.md files:** 34 total. All in `src/`, `.polaris/`, and `test/`.
**SUMMARY.md files:** 33 total. All in `src/`, `.polaris/`, and `test/`.

**Gaps — zero cognition files exist anywhere in `smartdocs/`:**

| Directory | POLARIS.md | SUMMARY.md | Note |
|-----------|-----------|-----------|------|
| `smartdocs/` | ✗ | ✗ | Vault root — no cognition |
| `smartdocs/docs/` | ✗ | ✗ | Content root — no cognition |
| `smartdocs/docs/architecture/` | ✗ | ✗ | Stable, non-generated |
| `smartdocs/docs/audits/` | ✗ | ✗ | Stable |
| `smartdocs/docs/doctrine/` | ✗ | ✗ | Stable |
| `smartdocs/docs/doctrine/active/` | ✗ | ✗ | Canonical authority |
| `smartdocs/docs/doctrine/candidate/` | ✗ | ✗ | Stable |
| `smartdocs/docs/doctrine/deprecated/` | ✗ | ✗ | Stable archive |
| `smartdocs/docs/raw/` | ✗ | ✗ | Ingest staging |
| `smartdocs/docs/specs/` | ✗ | ✗ | Stable |
| `smartdocs/docs/specs/active/` | ✗ | ✗ | Canonical authority |
| `smartdocs/docs/integrations/` | ✗ | ✗ | Stable |
| `smartdocs/docs/runtime/` | ✗ | ✗ | Generated — excluded |

**Why the gap exists:** `isDirectoryEligible()` in `smartdoc-ignore.ts` does not exclude `smartdocs/` paths, but `seedInstructionsAll()` / `seedSummaryAll()` have never been run against the smartdocs subtree. The `.smartdocignore` default patterns explicitly protect `smartdocs/docs/doctrine/**`, `smartdocs/docs/specs/active/**`, etc. from *ingest* — but not from *seeding*. This means seeding could add cognition files today, but no one has done it.

### 1.3 Route Coverage

`.polaris/map/file-routes.json`: 233 routes / 448 indexed files = **52% coverage**.

The atlas covers `src/`, `.polaris/`, `test/`, `scripts/`. It does **not** contain any route entries for `smartdocs/` content files. The 128 occurrences of "smartdocs" in `file-routes.json` are all route entries for `src/smartdocs-engine/` source files, not for content inside the vault.

**Gap:** No SmartDocs content paths are routable via `.polaris/map`. Agents have no atlas-backed route to navigate to doctrine, specs, or architecture docs.

### 1.4 Frontmatter / YAML Linking

**Current implementation:**
- `doctrine.ts` has `parseFrontMatter()` and `addCandidateGovernanceMetadata()`.
- Governance fields on candidate docs: `doc-type`, `confidence`, `recommended-action`, `overlap-analysis`.
- Canon-check uses `.polaris/map` for routing, not doc frontmatter.
- Some promoted docs use ad-hoc frontmatter (e.g., `smartdocs-summary-architecture.md` has `status`, `candidate-since`, `source`).

**No canonical schema** exists for relationship linking (`implements`, `related`, `supersedes`, `depends_on`, etc.). The `provenance.json` sidecar files encode `linkedMapArea` for spec promotion gating but have no standardized relationship vocabulary.

### 1.5 Telemetry and Runtime Artifact Surfaces

**Older surfaces (`.taskchain_artifacts/`):**

| Surface | Type | Notes |
|---------|------|-------|
| `polaris-run/runs/*/telemetry.jsonl` | Run execution telemetry | ~15+ runs; format = JSONL events |
| `polaris-analyze/runs/*/telemetry.jsonl` | Analysis run telemetry | Active — used by this workflow |
| `docs-ingest/runs/*/telemetry.jsonl` | Doc ingest telemetry | Legacy surface |
| `polaris-docs-ingest/runs/*/telemetry.jsonl` | Renamed ingest telemetry | Parallel to docs-ingest |
| `polaris-docs-migrate/*/` | Migration artifacts | Run-specific lifecycle logs |
| `polaris-doctrine/*/lifecycle.jsonl` | Doctrine lifecycle events | Active |
| `evo-run/runs/*/` | Evolution run telemetry | Likely legacy |
| `bootstrap-run/runs/*/` | Bootstrap run telemetry | Likely legacy |

**Newer runtime state contracts:**
- `.polaris/clusters/<id>/clusters.json` — sealed cluster packets
- `.polaris/clusters/<id>/packets/<id>.json` — sealed child assignment packets
- `.polaris/clusters/<id>/results/<id>.json` — sealed worker results
- `.polaris/runs/ledger.jsonl` — canonical run ledger (since POL-198)
- `src/loop/dispatch-state.ts` — `WorkerTelemetryEvent` types (specified by POL-215)

**POL-215 (`worker-telemetry-spec.md`) status:** Spec is written and active. Implementation gap: `worker-acknowledged` event not emitted by `src/loop/worker.ts`. The telemetry event catalog is the new canonical contract for worker lifecycle events.

---

## 2. Target SmartDocs Directory Layout

### 2.1 Recommended Layout (Phased Migration)

**Phase 1 target (immediate, low risk):** Add cognition and routing; keep `smartdocs/docs/` path structure.

```text
smartdocs/
├── POLARIS.md          ← NEW: vault-level cognition
├── SUMMARY.md          ← NEW: vault-level compressed context
├── .obsidian/          (unchanged)
└── docs/
    ├── POLARIS.md      ← NEW
    ├── SUMMARY.md      ← NEW
    ├── architecture/
    │   ├── POLARIS.md  ← NEW
    │   └── SUMMARY.md  ← NEW
    ├── doctrine/
    │   ├── POLARIS.md  ← NEW
    │   ├── active/     (POLARIS.md ← NEW)
    │   ├── candidate/  (POLARIS.md ← NEW)
    │   └── deprecated/ (no cognition — archive)
    ├── raw/
    │   └── POLARIS.md  ← NEW
    ├── specs/
    │   ├── POLARIS.md  ← NEW
    │   ├── active/     (POLARIS.md ← NEW)
    │   └── implemented/(POLARIS.md ← NEW)
    ├── audits/         (POLARIS.md optional — workflow-driven)
    ├── decisions/      (POLARIS.md ← NEW — even if empty)
    └── integrations/   (POLARIS.md ← NEW)
```

**Phase 2 target (migration phase, higher risk):** Flatten `smartdocs/docs/` into `smartdocs/`.

```text
smartdocs/
├── POLARIS.md
├── SUMMARY.md
├── .obsidian/
├── architecture/
├── doctrine/
│   ├── active/
│   ├── candidate/
│   └── deprecated/
├── raw/
├── specs/
│   ├── active/
│   ├── implemented/
│   └── superseded/
├── audits/
├── decisions/
└── integrations/
```

Phase 2 requires updating CANONICAL_TARGET, all hardcoded paths in source, doctrine docs, and skill packets. It must be preceded by a full compatibility impact assessment.

### 2.2 Compatibility Assessment for Phase 2

**Impact surface for `smartdocs/docs/` → `smartdocs/` migration:**
- 9 non-test source files with 22 references require path updates
- 6 test files require path updates
- `smartdocs-summary-architecture.md` doctrine doc references `smartdocs/docs/doctrine/active/` (self-referential)
- `src/smartdocs-engine/POLARIS.md` — all paths
- All active and candidate doctrine/spec docs that self-reference paths
- `.smartdocignore` default patterns in code — need updating

**Shim decision:** A temporary `CANONICAL_TARGET` config override (reading from `polaris.config.json`) would allow the migration to be done in steps without hard-cutting all consumers at once. Recommended: add `smartdocs.canonicalRoot` to `polaris.config.json`, default `"smartdocs/docs"`, and migrate consumers one at a time.

---

## 3. Folder Cognition Placement Matrix

| Folder category | POLARIS.md | SUMMARY.md | Rationale |
|-----------------|-----------|-----------|-----------|
| Stable source domain (`src/<domain>/`) | Required | Required | Canonical; agent traversal origin |
| Stable subdomain (`src/<domain>/<sub>/`) | Required | Required if ≥5 files | Canonical nested module |
| SmartDocs vault root (`smartdocs/`) | Required | Required | Canonical doc origin |
| SmartDocs content root (`smartdocs/docs/`) | Required | Required | Canonical ingest target |
| SmartDocs stable subtree (doctrine/, specs/, etc.) | Required | Optional | Canonical authority subdirs |
| Active canonical tier (`doctrine/active/`, `specs/active/`) | Required | Recommended | High-importance; agent landing |
| Staging tier (`raw/`) | Required | Not required | Ingest entry point |
| Archive tier (`deprecated/`, `superseded/`, `implemented/`) | Optional | Not required | Low-priority archive |
| Empty canonical dir (`decisions/`) | Required POLARIS.md | Not required | Placeholder intent |
| `.polaris/` top-level runtime dirs | Required (already present) | Required (already present) | Runtime cognition |
| `.polaris/` generated subdirs (`bootstrap/`, `clusters/<id>/`) | Excluded | Excluded | Runtime-generated |
| Test directories (`test/<domain>/`) | Required | Recommended | Mirror of src structure |
| Runtime/generated (`.taskchain_artifacts/`, `generated/`, `summaries/`) | Excluded | Excluded | Ephemeral |
| Node.js/build artifacts (`node_modules`, `dist`, `build`) | Excluded | Excluded | Build artifacts |
| Hidden system/agent folders (`.claude/`, `.codex/`) | Excluded by default | Excluded by default | Opt-in via flag |

**Promotion rules for normally-ignored folders:**
- A folder can be promoted to cognition-eligible by adding an explicit entry in `.smartdocignore` with `!path/to/dir` (negation).
- Alternatively, `--include-agent-folders` or `--include-hidden` flags activate opt-in categories.
- Promotion must be documented in the folder's POLARIS.md "What belongs here" section.

---

## 4. Dynamic Cognition Generation and Validation Rules

### 4.1 Detection Trigger

Cognition gap detection should run at three points:
1. **Map validation** (`polaris map validate`) — report missing POLARIS.md/SUMMARY.md as findings
2. **Ingest pipeline** — after `polaris docs ingest`, detect newly eligible folders that lack cognition
3. **Standalone command** — `polaris docs validate-instructions --check-missing` reports all gaps with severity

### 4.2 Severity Levels

| Condition | Severity |
|-----------|----------|
| Missing POLARIS.md in canonical source domain dir | ERROR |
| Missing POLARIS.md in SmartDocs subtree canonical dir | ERROR |
| Missing POLARIS.md in stable test domain dir | WARNING |
| Missing SUMMARY.md in canonical domain dir (≥5 files) | WARNING |
| Missing SUMMARY.md in SmartDocs active/ tier | WARNING |
| Missing POLARIS.md in empty canonical placeholder dir | INFO |
| Missing cognition in archive tier | INFO (ignored by default) |

### 4.3 Idempotent Templates

Both `seedInstructions()` and `seedSummary()` already use `DRAFT_MARKER` (`<!-- polaris:draft -->`) and skip files that exist without the marker. No changes to the idempotency contract are required.

The issue is that `isDirectoryEligible()` currently returns `eligible: true` for `smartdocs/docs/` subtree paths, but `seedInstructionsAll()` has never been called targeting that subtree. The fix is to:
1. Add `smartdocs/` subtree to the default scan scope in `seedInstructionsAll()` and `seedSummaryAll()`.
2. Exclude `smartdocs/docs/runtime/` (generated), `smartdocs/.obsidian/` (system), and archive tiers by default.

### 4.4 Placement Decision Logic

The revised eligibility check should be:

```text
is_eligible(dir) =
  NOT in RUNTIME_EXCLUDED_DIR_PATTERNS
  AND NOT in .smartdocignore (effective patterns)
  AND NOT a .polaris generated subdirectory
  AND NOT hidden/system (unless opted in)
  AND NOT an archive tier (deprecated/, superseded/, implemented/) — WARNING only
  AND (
    is a src/ or test/ domain dir
    OR is a stable smartdocs/ content subtree dir
    OR is explicitly promoted via .smartdocignore negation
  )
```

---

## 5. Routing Update Plan

### 5.1 Folder and Subfolder Route Ownership

Current `file-routes.json` entries cover individual files but lack explicit folder routes. The proposed improvement:

1. Add a route entry for each canonical folder (not just its files).
2. Folder routes inherit the domain of their parent unless overridden by a local POLARIS.md.
3. SmartDocs subtree domain assignment:

| Path | Domain | Route | Taskchain |
|------|--------|-------|-----------|
| `smartdocs/` | `smartdocs` | `smartdocs` | `polaris-smartdocs` |
| `smartdocs/docs/` | `smartdocs` | `smartdocs/docs` | `polaris-smartdocs` |
| `smartdocs/docs/doctrine/active/` | `smartdocs.doctrine` | `smartdocs/docs/doctrine/active` | `polaris-smartdocs-doctrine` |
| `smartdocs/docs/specs/active/` | `smartdocs.specs` | `smartdocs/docs/specs/active` | `polaris-smartdocs-specs` |
| `smartdocs/docs/raw/` | `smartdocs.ingest` | `smartdocs/docs/raw` | `polaris-docs-ingest` |

### 5.2 Route Inheritance

- Files in a folder inherit the folder's domain/route/taskchain if not individually overridden.
- Subfolder routes specialize the parent: `smartdocs.doctrine` is a child of `smartdocs`.
- Nested folder POLARIS.md can override the parent route by declaring a `Related routes` section pointing to its own domain.

### 5.3 Generated Descendants Exclusion

Runtime/generated subdirs are excluded by a combination of:
- Prefix exclusion in `POLARIS_RUNTIME_GENERATED_DIR_PREFIXES`
- Pattern exclusion in `RUNTIME_EXCLUDED_DIR_PATTERNS`
- `.smartdocignore` default patterns (already covers `**/generated/**`, `**/summaries/**`)

No changes needed to existing exclusion logic. New exclusion needed: `smartdocs/docs/runtime/**` should be added to default ignore patterns or documented as excluded in POLARIS.md.

---

## 6. YAML/Frontmatter Schema for SmartDocs Relationship Links

### 6.1 Canonical Frontmatter Schema

All SmartDocs files promoted beyond `raw/` should support this schema:

```yaml
---
id: <optional unique slug, e.g. smartdocs-summary-architecture>
kind: doctrine | spec | architecture | integration | analysis | decision | raw
status: raw | candidate | active | deprecated | superseded | implemented
owner: <team or domain name>
source: <original path if migrated>
created: <ISO date>
updated: <ISO date>

# Governance (candidate/active only)
doc-type: <doctrine | spec | architecture | ...>
confidence: <0.0–1.0>
recommended-action: hold | promote | deprecate
overlap-analysis: <prose>

# Relationships
implements: [<issue-id or doc-id>, ...]
related: [<doc-id or issue-id>, ...]
supersedes: <doc-id>
superseded_by: <doc-id>
depends_on: [<doc-id>, ...]
validates: [<issue-id>, ...]
source_paths: [<repo-relative path>, ...]
---
```

### 6.2 Relationship Vocabulary

| Field | Meaning |
|-------|---------|
| `implements` | This doc is the spec/doctrine that an issue or code change implements |
| `related` | Related docs or issues without a directional dependency |
| `supersedes` | This doc replaces a prior doc (prior should link `superseded_by`) |
| `superseded_by` | This doc has been replaced by a newer doc |
| `depends_on` | This doc depends on another doc being stable first |
| `validates` | This doc defines acceptance criteria for an issue or implementation |
| `source_paths` | Repo paths that this doc governs or is authoritative for |

### 6.3 How YAML Links Feed Downstream Systems

| Consumer | Usage |
|----------|-------|
| Route map generation | `source_paths` → populate atlas route entries for doc-governed paths |
| Canon-check | `implements` → link worker output to governing spec/doctrine |
| Ingest pipeline | `kind`, `status` → classify doc placement (raw → candidate → active) |
| Query / search | All fields → answer "what governs path X?" or "what does issue Y produce?" |
| Worker context | `related`, `depends_on` → surface context docs during worker dispatch |

### 6.4 Migration Plan for Existing Docs

1. **Priority 1 (active doctrine/specs):** Add frontmatter to all files in `smartdocs/docs/doctrine/active/` and `smartdocs/docs/specs/active/`. Use `addCandidateGovernanceMetadata()` as the insertion tool; extend it to support the full relationship fields.
2. **Priority 2 (candidate docs):** Already get partial governance fields from `addCandidateGovernanceMetadata()`. Extend with relationship fields on promotion.
3. **Priority 3 (architecture, integrations):** Add `kind`, `status`, `source_paths` at minimum.
4. **Raw docs:** No frontmatter required — added on promotion.

---

## 7. Telemetry / Artifact Deprecation and Safe Removal Plan

### 7.1 Classification

| Surface | Classification | Rationale |
|---------|---------------|-----------|
| `.taskchain_artifacts/polaris-run/runs/*/telemetry.jsonl` | Canonical | Active run-level telemetry; consumed by run ledger |
| `.taskchain_artifacts/polaris-analyze/runs/*/telemetry.jsonl` | Canonical | Active analysis telemetry |
| `.taskchain_artifacts/polaris-doctrine/*/lifecycle.jsonl` | Canonical | Active doctrine lifecycle events |
| `.taskchain_artifacts/docs-ingest/runs/*/telemetry.jsonl` | Compatibility-only | Renamed to `polaris-docs-ingest`; both coexist |
| `.taskchain_artifacts/polaris-docs-ingest/runs/*/telemetry.jsonl` | Canonical | Current name for doc ingest telemetry |
| `.taskchain_artifacts/polaris-docs-migrate/*/` | Compatibility-only | One-off migration runs; no active writer |
| `.taskchain_artifacts/evo-run/runs/*/` | Deprecated | No active `evo-run` skill in `.polaris/skills/` |
| `.taskchain_artifacts/bootstrap-run/runs/*/` | Deprecated | Bootstrap now uses polaris-run skill |
| `.polaris/runs/ledger.jsonl` | Canonical | New canonical run ledger (since POL-198) |
| `.polaris/clusters/*/clusters.json` | Canonical | Sealed cluster packets — durable |
| `.polaris/clusters/*/results/*.json` | Canonical | Sealed results — durable |
| `src/loop/dispatch-state.ts` WorkerTelemetryEvent types | Canonical | New spec (POL-215); implementation gap on `worker-acknowledged` |

### 7.2 Migration Guards Before Removal

Before removing any deprecated surface:
1. Confirm no active writer or reader references the path in `src/`.
2. Check `.polaris/skills/` for any step file referencing the path.
3. Archive the data to `.polaris/runs/` or equivalent durable store if it has audit value.
4. Add a removal record to `.polaris/runs/ledger.jsonl`.

### 7.3 Concrete Removals Permitted

| Action | Condition |
|--------|-----------|
| Remove `.taskchain_artifacts/evo-run/` | Confirm no `evo-run` skill exists and no active reference in src/ |
| Remove `.taskchain_artifacts/bootstrap-run/` | Confirm bootstrap uses `polaris-run` exclusively |
| Remove `docs-ingest` surface after renaming complete | Confirm all writers use `polaris-docs-ingest` |

---

## 8. Implementation Ordering

Five implementation issues are proposed, in safe execution order:

### Cluster 01 — Cognition Foundation (no migration risk)

**Child A: Add folder cognition to SmartDocs vault tree**
- Add POLARIS.md and SUMMARY.md to `smartdocs/`, `smartdocs/docs/`, and all stable subdirectories.
- Extend `isDirectoryEligible()` (or scan config) to include `smartdocs/docs/` subtree in default seed scope.
- Exclude `smartdocs/docs/runtime/` from seed scope.
- Validate with `polaris docs validate-instructions`.

**Child B: Add SmartDocs routes to atlas**
- Run `polaris map update` to index `smartdocs/` content files.
- Define domain/route/taskchain for SmartDocs subtree in `file-routes.json`.
- Document route inheritance rules in `src/map/POLARIS.md`.

### Cluster 02 — YAML/Frontmatter Schema

**Child C: Define and implement canonical frontmatter schema**
- Write the frontmatter schema spec to `smartdocs/docs/specs/`.
- Extend `parseFrontMatter()` to support full relationship fields.
- Extend `addCandidateGovernanceMetadata()` to insert relationship fields.
- Add frontmatter migration for all existing active doctrine and spec files.
- Define how `source_paths` feeds route map generation.

### Cluster 03 — Telemetry Cleanup

**Child D: Inventory and clean legacy telemetry surfaces**
- Audit all `.taskchain_artifacts/` surfaces.
- Confirm `evo-run` and `bootstrap-run` have no active writers.
- Archive and remove deprecated surfaces under migration guards.
- Document surface classification in `.polaris/runs/POLARIS.md`.

### Cluster 04 — SmartDocs Path Migration (highest risk, last)

**Child E: Migrate `smartdocs/docs/` to `smartdocs/` canonical root**
- Add `smartdocs.canonicalRoot` to `polaris.config.json` with default `"smartdocs/docs"`.
- Update `CANONICAL_TARGET` in `ingest.ts` to read from config.
- Update all hardcoded paths in `doctrine.ts`, `migrate.ts`, `smartdoc-ignore.ts`, `index.ts`.
- Update `skill-packet/generator.ts` and `cognition/summary-delta.ts`.
- Move files from `smartdocs/docs/` to `smartdocs/` (one category at a time).
- Update all doctrine docs that self-reference `smartdocs/docs/` paths.
- Full test suite must pass before merging.

---

## 9. Validation Checklist

- [ ] All stable `smartdocs/` subdirectories have POLARIS.md
- [ ] All stable `smartdocs/docs/` subdirectories have POLARIS.md (doctrine/active/, specs/active/, raw/, etc.)
- [ ] `polaris docs validate-instructions` reports 0 ERRORs
- [ ] `smartdocs/` paths appear in `.polaris/map/file-routes.json`
- [ ] Active doctrine/spec files have canonical frontmatter (`kind`, `status`, `source_paths`)
- [ ] `parseFrontMatter()` parses relationship fields without regression
- [ ] All active test suites pass after any path change
- [ ] `evo-run` and `bootstrap-run` directories removed only after confirmation
- [ ] `polaris-docs-ingest` is the sole active doc ingest surface
- [ ] `worker-acknowledged` implementation gap tracked in follow-up (POL-215 scope)

---

## 10. Rollback Strategy

**Cognition files (Clusters 01–02):** POLARIS.md and SUMMARY.md additions are additive-only. Rollback = `git revert` of the commit adding the files. No functional risk.

**Atlas route additions (Cluster 01B):** `file-routes.json` is a derived artifact. Rollback = re-run `polaris map update` without SmartDocs paths in scope.

**Frontmatter additions (Cluster 02):** Doc frontmatter is additive. Existing parsers ignore unknown fields. Rollback = `git revert` the frontmatter commits.

**Telemetry removal (Cluster 03):** Before removal, archive data to `.polaris/`. If rollback needed, restore from archive. Never delete `ledger.jsonl`.

**Path migration (Cluster 04):** Highest risk. Mitigation:
1. The `smartdocs.canonicalRoot` config key acts as a feature flag.
2. All migrations happen in one branch; merge only after full test pass.
3. Keep `smartdocs/docs/` as an empty directory with a `MOVED.md` marker for one release cycle.
4. Rollback = revert config key to `"smartdocs/docs"` and revert file moves.
