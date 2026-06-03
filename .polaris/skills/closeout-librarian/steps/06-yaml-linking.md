---
name: closeout-librarian-step-06
description: Update YAML frontmatter references, SUMMARY.md cognition mappings, and cognition index entries for promoted or ingested documents.
---

# Step 06 — YAML Linking

## Purpose

When documents are promoted or ingested, the project's internal reference graph must
be updated so promoted documents can be discovered through cognition and summary artifacts.

## What Must Be Updated

### 6.1 Promoted Document YAML Frontmatter

For each document promoted to `smartdocs/specs/active/` in step 04:
- Ensure `status: active` in frontmatter (set if missing).
- Ensure `created` date is present (set if missing).
- Add `promoted_by: closeout-librarian` metadata if not present.
- Do NOT modify the document body beyond frontmatter.

### 6.2 SUMMARY.md Cognition References

When SUMMARY.md files were updated in step 03 and reference cognition indexes or spec
documents, ensure those references use the post-promotion canonical paths.

Specifically: if step 04 promoted a document from `raw/` to `specs/active/`, any
SUMMARY.md reference to the old raw path should be updated to the new canonical path.

This is a targeted fixup following the broader link validation in step 05. Step 05 handles
structural link repair; step 06 handles the semantic reference graph.

### 6.3 Cognition Index Updates

For each folder that had cognition notes archived in step 04:
1. Read the existing `cognition-index.json` (or initialize if not present).
2. Add a reconciliation record:
   ```json
   {
     "run_id": "<packet.run_id>",
     "reconciled_at": "<ISO timestamp>",
     "notes_archived": ["<filename>", ...],
     "patches_applied": ["<polaris.md path>", ...],
     "librarian_confidence": <average confidence from step 02>,
     "status": "applied" | "no-change" | "rejected",
     "librarian_role": "closeout-librarian"
   }
   ```
3. Write the updated `cognition-index.json`.

### 6.4 SmartDocs Reference Discovery

If any SUMMARY.md references `smartdocs/specs/active/*.md` files, verify those files
were not renamed or moved during this session. If they were, update the reference.

## Write Constraints

All YAML updates must:
1. Preserve the rest of the file content unchanged.
2. Stay within `packet.allowed_write_paths`.
3. Not modify document bodies (only frontmatter and frontmatter-level metadata files).

## Actions

### 6.1 Frontmatter Updates

For each promoted document (from step 04 `docs_ingested` list):
- Update `status`, `created`, `promoted_by` fields.
- Write the updated frontmatter block.

### 6.2 Summary Reference Updates

For each SUMMARY.md written in step 03:
- Find references to documents promoted in step 04.
- Update raw→canonical path.

### 6.3 Cognition Index Write

For each folder with archived cognition notes (from step 04):
- Load or initialize `cognition-index.json`.
- Append the reconciliation record.
- Write the file.

## Output

Running list for step 08:
```yaml
yaml_updates: [
  { file: "<path>", action: "update", change_summary: "<≤50 words>" },
  ...
]
```

Proceed to step 07.
