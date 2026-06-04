---
name: closeout-librarian-step-04
description: Inspect documentation associated with completed work. Ingest, promote, archive, or skip.
---

# Step 04 — Documentation Ingestion

## Purpose

The Librarian inspects documentation associated with the completed cluster and determines
what action each document requires. Implementation work frequently produces accompanying
documentation that has not yet been formally ingested into the SmartDocs authority hierarchy.

## Document Sources to Inspect

1. **`packet.smartdocs_raw_paths`** — raw documents in `smartdocs/raw/` that may be
   related to completed work
2. **Documents referenced in child summaries** — specs, analyses, or plans linked by children
3. **Documents referenced in run report** — related planning/analysis docs
4. **Cognition notes** (`packet.cognition_notes`) — worker notes from this cluster

## Ingestion Decision Matrix

For each candidate document:

| Condition | Action |
|---|---|
| Document is a spec for implemented behavior, not yet in `specs/active/` | Ingest → `smartdocs/specs/active/` |
| Document is a one-time analysis, no ongoing authority | Archive → `smartdocs/raw/` (keep in place, mark as analyzed) |
| Document is a postmortem or lessons-learned | Keep raw, record in result |
| Document is obsolete (superseded by newer spec) | Archive or deprecate |
| Document is doctrine candidate (stable, widely applicable) | Ingest → `smartdocs/doctrine/candidate/` (NOT `doctrine/active/` — requires operator) |
| Document is unrelated to completed work | Skip |
| Document already promoted (in `specs/active/` or `doctrine/active/`) | Skip |

## Promotion Boundaries

**The Closeout Librarian may promote to:**
- `smartdocs/specs/active/` (specifications for implemented behavior)
- `smartdocs/` classification tiers (raw → candidate)

**The Closeout Librarian may NOT promote to:**
- `smartdocs/doctrine/active/` — requires explicit operator approval
- `smartdocs/architecture/` — requires explicit operator approval

When a document warrants `doctrine/active` promotion, record it in the result as a
promotion recommendation for operator review.

## Frontmatter Requirements

When ingesting a document into `smartdocs/specs/active/`:
1. Ensure the document has valid YAML frontmatter.
2. Required fields: `kind`, `status`, `source`, `created`.
3. Add or update: `status: active`, `created: <ISO date>`.
4. Do not modify the document body.

When creating a provenance file (`.provenance.json`):
```json
{
  "promoted_from": "<source path>",
  "promoted_at": "<ISO date>",
  "promoted_by": "closeout-librarian",
  "run_id": "<packet.run_id>",
  "cluster_id": "<packet.cluster_id>"
}
```

## Cognition Note Archival

After POLARIS.md and SUMMARY.md reconciliation is complete, move all resolved pending
cognition notes from `packet.cognition_notes` to archive:
- Source: `.polaris/cognition/pending/<folder-slug>/<file>`
- Destination: `.polaris/cognition/archive/<folder-slug>/<file>`
- Update `cognition-index.json` for the folder

## Actions

### 4.1 Enumerate Candidates

Build a list of candidate documents from all sources (raw paths, child summaries, run report).
Deduplicate. Exclude already-promoted documents.

### 4.2 Classify Each Candidate

Apply the decision matrix above. Assign one of: `ingest`, `promote`, `archive`, `skip`.

### 4.3 Execute Ingestion

For each document classified as `ingest` or `promote`:
1. Verify target path is in `packet.allowed_write_paths`.
2. Copy/move to target location.
3. Update or add frontmatter.
4. Create provenance file.
5. Record in `docs_ingested` list.

For each document classified as `archive`:
1. No file move required (raw docs stay in place).
2. Record in `docs_archived` list with reason.

### 4.4 Archive Cognition Notes

Move all pending cognition notes in `packet.cognition_notes` to archive.
Update `cognition-index.json` for each affected folder.

## Output

Running lists for step 08:
```yaml
docs_ingested: [{ source_path, target_path, action: "ingest"|"promote", reason }]
docs_archived: [{ source_path, target_path: null, action: "archive", reason }]
cognition_archived: [{ note_path, archive_path }]
```

Proceed to step 05.
