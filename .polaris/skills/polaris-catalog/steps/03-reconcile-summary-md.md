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
