---
status: raw
doc-type: schema-spec
source_issue: POL-445
superseded_source_issue: POL-441
related: smartdocs-2-0-architecture
implements: POL-445
generated_by: polaris-run
run_id: polaris-run-pol-443-2026-07-03-001
---

# SmartDocs Frontmatter Extension Schema

**Status:** Raw schema specification. **Scope:** documents the reserved YAML frontmatter keys used
by SmartDocs for governance, provenance, and future cross-repo federation. This document is the
single source of truth for both repo-local and federation-facing keys; see
`smartdocs/raw/smartdocs-2-0-architecture.md` §7.5 and §7.14 for architectural context.

## Conformance baseline

All SmartDocs are Markdown files with a YAML frontmatter block delimited by `---`. Under the Open
Knowledge Format (OKF v0.1) §4.1, unknown frontmatter keys MUST be tolerated and preserved by any
conformant reader. The keys below are reserved by SmartDocs on top of that baseline; they are
expected to be absent on most documents until an author or an automated step intentionally populates
them.

## Schema overview

Keys are grouped into three categories:

1. **Identity / lifecycle** — what the document is and where it sits in the doctrine lifecycle.
2. **Governance / provenance** — confidence, ownership, overlap, and ingest traceability.
3. **Relationship / federation** — how the document relates to sibling docs and to shared LSCT
doctrine across repositories.

All values are stored as strings in the YAML frontmatter block, with one exception: the
`confidence` key uses a numeric scalar (`0.0`–`1.0`) to support automated confidence-gated
promotion. Lists or other structured values are represented as single-line string values (e.g.,
comma-separated paths, YAML flow-style lists) and parsed by consumers that care about them;
generic OKF readers see only the raw string.

## Identity and lifecycle keys

| Key | Purpose | Default / inactive state |
|---|---|---|
| `id` | Optional stable identifier for the concept, distinct from the file path. | Absent. |
| `kind` | High-level classification (e.g., `doctrine`, `spec`, `analysis`, `decision`). | Absent. |
| `status` | Lifecycle status; must agree with the directory tier (`raw`, `candidate`, `active`, `deprecated`). | `raw` for newly ingested docs; otherwise directory-implied. |
| `owner` | Team, role, or individual responsible for the document. | Absent. |
| `created` | ISO-8601 creation timestamp. | Absent. |
| `updated` | ISO-8601 last-modification timestamp. | Absent. |
| `doc-type` | Governance role of the document within the promotion lifecycle (e.g., `doctrine`, `spec`). | Absent until `addCandidateGovernanceMetadata` scaffolds it. |
| `candidate-since` | ISO-8601 timestamp when the doc entered `smartdocs/doctrine/candidate/`. | Absent. |

## Governance and provenance keys

| Key | Purpose | Default / inactive state |
|---|---|---|
| `source` | Original file path or URI the document was ingested from. | Absent. |
| `confidence` | Numeric confidence score (`0.0`–`1.0`) used for confidence-gated promotion decisions. | `0.0` when scaffolded by `addCandidateGovernanceMetadata`; absent otherwise. |
| `recommended-action` | Lifecycle recommendation: `promote`, `hold`, `deprecate`, etc. | `hold` when scaffolded; absent otherwise. |
| `overlap-analysis` | Free-text assessment of overlap with existing active doctrine/specs. | `pending` when scaffolded; absent otherwise. |
| `ingest-run-id` | Run identifier that ingested the document. | Absent. |
| `ingest-cluster` | Cluster identifier associated with the ingest run. | Absent. |
| `classified-as` | Classification result from `classifyDocWithConfidence` (e.g., `doctrine-candidate`). | Absent. |
| `linked-map-area` | Map area or route this document governs, for route-local cognition linkage. | Absent. |
| `ingested-at` | ISO-8601 timestamp when the document was ingested. | Absent. |

## Relationship keys

| Key | Purpose | Default / inactive state |
|---|---|---|
| `implements` | Identifier(s) of concept(s) this document implements. | Empty string when scaffolded; absent otherwise. |
| `related` | Identifier(s) of related sibling concepts. | Empty string when scaffolded; absent otherwise. |
| `supersedes` | Identifier(s) of concepts this document replaces. | Empty string when scaffolded; absent otherwise. |
| `superseded_by` | Identifier(s) of concepts that replace this document. | Empty string when scaffolded; absent otherwise. |
| `depends_on` | Identifier(s) of concepts this document depends upon. | Empty string when scaffolded; absent otherwise. |
| `validates` | Identifier(s) of concepts or contracts this document validates. | Empty string when scaffolded; absent otherwise. |
| `source_paths` | Comma-separated list of source file paths this document describes; enriches SUMMARY.md delta signals. | Empty string when scaffolded; absent otherwise. |

## Federation metadata keys (reserved now, activated later)

These keys are declared in `smartdocs-2-0-architecture.md` §7.14. They are reserved for future LSCT-Wiki
federation and are NOT populated by any current scaffold or ingest step. Generic OKF readers must
tolerate them as unknown extension keys; Polaris-aware tools may name them in the
`ParsedFrontMatter` type for documentation only.

| Key | Purpose | Default / inactive state |
|---|---|---|
| `repo_id` | Stable slug identifying the originating repo (`polaris`, `git-fit`, `fractrak`, …). | Required only on concepts a repo explicitly marks federation-relevant; otherwise absent. |
| `project_id` | Distinguishes multiple products inside one repo, if applicable. | Defaults to `repo_id` when a repo hosts a single product. |
| `authority_scope` | Authority boundary: `repo-local`, `lsct-shared`, or `inherited-local-instance`. See `smartdocs-2-0-architecture.md` §7.13. | Defaults to `repo-local`, i.e., today's unchanged behavior. |
| `inherits_from` | Edge(s) to the shared LSCT doctrine concept(s) a repo-local doc builds on. | Empty until a repo explicitly opts a doctrine doc in. |
| `upstream_standard` | Pointer (plus version/date) to the specific shared standard a doc claims to conform to. | Empty by default. |
| `conformance` | Conformance posture: `conforms`, `diverges`, or `not-applicable`. | Defaults to `not-applicable` for concepts with no shared-standard relationship. |
| `divergence_rationale` | Required free text when `conformance: diverges`. | N/A unless `conformance: diverges` is set. |
| `cross_repo_refs` | List of `{repo_id, concept_id}` pairs the federation can resolve as edges. Stored as a string value; consumers that need structure parse it. | Empty list by default; degrades to an ordinary unknown extension key for any non-federation-aware consumer. |

## Unknown-key tolerance

Any key not listed here is still permitted in SmartDocs frontmatter. `parseFrontMatter` preserves it
through the `ParsedFrontMatter` index signature (`[key: string]: string | undefined`). Validation
 tooling may warn about unexpected keys for specific directory tiers, but it MUST NOT reject a
document solely for carrying an unrecognized key.
