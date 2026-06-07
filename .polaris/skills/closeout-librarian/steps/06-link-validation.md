---
name: closeout-librarian-step-06
description: Validate markdown links, YAML references, and cognition references. Repair where possible.
---

# Step 06 — Link Validation

## Purpose

Documentation changes and promotions in steps 03–05 may create or expose broken links.
This step validates references across affected documentation and repairs them where possible.

## Scope of Validation

Validate links only in files that were written or affected during this session:
- POLARIS.md files updated in step 03
- SUMMARY.md files updated in step 04
- Documents ingested in step 05
- Provenance files created in step 05

Do NOT validate the entire repository. Scope is limited to files touched by this session.

## Link Types to Validate

### Markdown Links

```markdown
[text](path)
[text](path#anchor)
```

Validate that the target path exists relative to the document location.

### Wiki-style Links

```markdown
[[document-name]]
[[folder/document]]
```

Validate that the referenced document exists in `smartdocs/`.

### YAML Frontmatter References

```yaml
depends_on:
  - foreman-worker-architecture.md
supersedes: old-spec.md
related:
  - worker-session-contract.md
```

Validate that referenced files exist in their expected locations.

### Promotion References

When a document was promoted from `smartdocs/raw/` to `smartdocs/specs/active/`, any
existing references to the raw location (in files written this session) should be updated
to point to the new canonical location.

### Cognition References

In SUMMARY.md files, references to cognition notes or archive entries should resolve
correctly after archival in step 05.

## Repair Heuristics

### Broken Relative Path

If a relative path is wrong but the target file exists at a different relative path:
1. Compute the correct relative path.
2. Update the link.
3. Record as repaired.

### Promoted Document Reference

If a link points to `smartdocs/raw/<file>` and the file was promoted to
`smartdocs/specs/active/<file>` in step 05:
1. Update the link to the new canonical path.
2. Record as repaired.

### Unrepairable Links

A link is unrepairable when:
- The target file does not exist anywhere in the repository.
- The link is ambiguous (multiple matching targets).
- The link is to an external URL (do not modify external links).

Record unrepairable links in the result and continue. Do not fail the session over
unrepairable links.

## Actions

### 6.1 Collect Links

For each file written in steps 03–05, extract all link references (markdown, YAML, wiki).

### 6.2 Validate Each Link

Check whether the target exists. Classify as: valid, broken-repairable, broken-unrepairable,
external (skip).

### 6.3 Repair

For each broken-repairable link:
1. Verify the source file is in `packet.allowed_write_paths`.
2. Apply the repair (update the link in the file).
3. Record in `links_repaired`.

### 6.4 Record Results

Build the link validation report for step 09.

## Output

```yaml
link_validation_report:
  total_checked: <n>
  valid: <n>
  broken: <n>
  repaired: <n>
  unrepairable: ["<path>: <description>", ...]
```

Unrepairable links are added to the session blockers list with `resolution_required: false`
(informational only — they do not block the Librarian commit).

Proceed to step 07.
