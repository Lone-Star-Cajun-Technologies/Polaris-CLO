---
name: polaris-catalog-step-03
description: Refresh SUMMARY.md files to reflect current project state after the completed work.
---

# Step 03 — Reconcile SUMMARY.md

Identical in behavior to `polaris-reconcile` step 03. See
`.polaris/skills/polaris-reconcile/steps/03-reconcile-summary-md.md` for full detail.

## Summary

For each folder in `work_inventory.affected_folders` that has a SUMMARY.md:
1. Assess staleness against the completed work.
2. Remove stale information. Replace superseded references. Preserve current understanding.
3. Write the full updated SUMMARY.md — net new line cap of `packet.constraints.max_summary_addition_lines` (default: 50).
4. Record in `summary_md_updates`.

SUMMARY.md is NOT a changelog. It must read as a coherent current-state snapshot.

## Required Structure (per June 5 doctrine)

SUMMARY.md must contain the following sections:

### Current State
Brief description of what is implemented, what is not yet, and known gaps.

### Route Health
Current operational condition. Example subsections:
- Healthy
- Monitoring
- Known Issues
- Recent Treatments
- Improvement Opportunities

Goal: Workers understand route condition in under 10 seconds. Not history, not doctrine, not implementation detail.

### Canonical References
YAML block listing navigation paths (not reading assignments):

```yaml
canonical_docs:
  - smartdocs/active/runtime/worker-packet-contract.md
  - smartdocs/active/runtime/librarian-closeout.md
  - POLARIS.md
```

These are retrieval paths, not preload instructions.

## Reconciliation Behavior

- Do NOT overwrite an existing Route Health section if it has content
- Do NOT auto-populate Route Health status from runtime data — scaffold a skeleton only
- Canonical References block must use the `canonical_docs:` key
- Preserve any existing valid content; only update stale state sections

## Output

```yaml
summary_md_updates: [
  { file: "<path>", action: "update", change_summary: "<≤50 words>" },
  { file: "<path>", action: "no_change" },
  { file: "<path>", action: "path_not_allowed" },
  ...
]
```

## Next step

04-classify-and-place
