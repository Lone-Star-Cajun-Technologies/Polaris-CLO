<!-- BEGIN POLARIS GENERATED -->
<!-- polaris:template-version: 1 -->
# smartdocs/specs/raw

## Purpose

Pre-promotion staging area for SmartDocs specifications. Raw specs land here when written by workers or operators but have not yet been promoted to `smartdocs/specs/active/`. Every file in this folder carries `status: raw` frontmatter and a `<!-- polaris:draft -->` marker until reviewed and promoted.

## What belongs here

- Architecture specs written during cluster work that are not yet ready for active promotion
- `pol-325-capability-matrix.md`, `pol-325-codegraph-architecture.md`, `pol-325-integration-options.md` — CodeGraph integration analysis specs from POL-325
- `pol-478-self-optimization-loop-architecture.md` — SOL architecture spec: bounded evidence-based optimization loop that observes completed runs, evaluates Foreman/worker performance, maintains local historical trends, and emits review-gated recommendations; written by POL-478

## What does not belong here

- Finalized and reviewed specifications (promote to `smartdocs/specs/active/`)
- Non-spec ingest material (use `smartdocs/raw/`)
- Generated runtime artifacts

## Editing rules

- All files here carry `status: raw` frontmatter; do not remove this until promotion is approved.
- Promotion to `active/` requires operator review and removal of the `<!-- polaris:draft -->` marker.
- Do not create implementation files based solely on raw specs; treat them as drafts until promoted.

## Architecture assumptions

- Assumes every promotion candidate is reviewed by the Closeout Librarian or an operator before being copied to `smartdocs/specs/active/`; nothing here is authoritative.

## Read before editing

- `smartdocs/specs/active/docs-authority-model.md`

## Related routes

- `smartdocs/specs/active/` — promoted and reviewed specifications
- `smartdocs/raw/` — general ingest staging for non-spec documents

<!-- END POLARIS GENERATED -->