---
kind: spec
status: raw
source: POL-237
created: 2026-05-31
owner: Polaris
---

# SmartDoc Canonical Frontmatter Schema

**Status:** Candidate spec — pending promotion to `specs/active/`
**Issue:** POL-237
**Cluster:** POL-234

---

## 1. Purpose

This document defines the canonical YAML frontmatter schema for all Polaris SmartDocs (files in `smartdocs/docs/`). Frontmatter enables:

- Automated classification and routing through the ingest pipeline
- Relationship linking between docs and source code (`source_paths`)
- Lifecycle governance (promotion, deprecation)
- SUMMARY.md delta signal enrichment

---

## 2. Schema Reference

All fields are optional unless marked **required**. Omitted fields are treated as absent (not default-filled) by the parser.

### 2.1 Identity Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Stable doc identifier (e.g., `POL-237-frontmatter-schema`) |
| `kind` | **required** string | Doc type: `spec`, `doctrine`, `architecture`, `decision`, `audit`, `raw` |
| `status` | **required** string | Lifecycle state: `raw`, `candidate`, `active`, `deprecated` |
| `owner` | string | Team or individual responsible for this doc |
| `source` | string | Origin of the doc (issue ID, file path, conversation reference) |
| `created` | string | ISO 8601 date of creation (YYYY-MM-DD) |
| `updated` | string | ISO 8601 date of last update (YYYY-MM-DD) |

### 2.2 Governance Fields (existing)

These fields are added by `addCandidateGovernanceMetadata()` during doctrine candidacy and are required before promotion.

| Field | Type | Description |
|-------|------|-------------|
| `doc-type` | string | Detailed doc sub-type (e.g., `doctrine`, `spec`) |
| `confidence` | number string | Reviewer confidence score (0.0–1.0) |
| `recommended-action` | string | `promote`, `hold`, `deprecate` |
| `overlap-analysis` | string | Overlap analysis result vs existing active docs |
| `candidate-since` | string | ISO 8601 date doc entered candidate status |

### 2.3 Relationship Fields (new in POL-237)

These fields link a SmartDoc to related documents and source code.

| Field | Type | Description |
|-------|------|-------------|
| `implements` | string | Comma-separated doc IDs/paths this doc implements or elaborates |
| `related` | string | Comma-separated doc IDs/paths that are related |
| `supersedes` | string | Comma-separated doc IDs/paths this doc supersedes |
| `superseded_by` | string | Doc ID/path that supersedes this doc |
| `depends_on` | string | Comma-separated doc IDs/paths this doc depends on |
| `validates` | string | Comma-separated doc IDs/paths whose assertions this doc validates |
| `source_paths` | string | **Key field** — comma-separated source file paths this doc describes. When these files are touched, SUMMARY.md delta signals fire. |

---

## 3. Minimum Required Frontmatter

Every file in `smartdocs/docs/doctrine/active/` and `smartdocs/docs/specs/active/` must have at minimum:

```yaml
---
kind: <spec|doctrine|architecture|decision>
status: active
source_paths: <comma-separated paths, or empty string if none>
---
```

---

## 4. Example: Doctrine File

```yaml
---
kind: doctrine
status: active
source: smartdocs/docs/raw/issue-hierarchy-doctrine.md
doc-type: doctrine
confidence: 0.95
recommended-action: promote
overlap-analysis: No overlap with existing active doctrine.
created: 2026-05-28
implements: ""
related: smartdocs/docs/specs/active/foreman-worker-architecture.md
supersedes: ""
superseded_by: ""
depends_on: ""
validates: ""
source_paths: src/loop/dispatch-state.ts,src/loop/dispatch-boundary.ts
---
```

---

## 5. Example: Spec File

```yaml
---
kind: spec
status: active
source: POL-213
created: 2026-05-29
implements: ""
related: smartdocs/docs/specs/active/foreman-worker-architecture.md
supersedes: ""
superseded_by: ""
depends_on: ""
validates: ""
source_paths: src/loop/dispatch-state.ts,src/loop/dispatch-boundary.ts
---
```

---

## 6. Parser Behavior

`parseFrontMatter()` in `src/smartdocs-engine/doctrine.ts` returns a `ParsedFrontMatter` object with all recognised fields typed. Unknown keys are preserved via the index signature `[key: string]: string | undefined`.

`addCandidateGovernanceMetadata()` scaffolds empty relationship fields on candidacy to prompt author review before promotion.

---

## 7. SUMMARY.md Delta Integration

When `applySummaryDelta()` runs with a set of touched files:

1. Standard SIGNAL_PATTERNS check (file path pattern match).
2. **source_paths enrichment** — scans all active doctrine/spec SmartDocs for `source_paths` entries. If any touched file matches a `source_paths` entry, a `linked-docs-changed` signal fires for that doc's SUMMARY.md.

This ensures SUMMARY.md stays current when source code covered by a SmartDoc changes.

---

## Linked Canonical Sources

- `src/smartdocs-engine/doctrine.ts` — `parseFrontMatter()`, `addCandidateGovernanceMetadata()`
- `src/cognition/summary-delta.ts` — `applySummaryDelta()`, `detectSourcePathSignals()`
- `smartdocs/docs/doctrine/active/smartdocs-summary-architecture.md` — POLARIS.md/SUMMARY.md responsibility boundaries
