---
name: polaris-catalog-step-02
description: Update affected POLARIS.md files to accurately reflect the current state of each folder after the completed work.
---

# Step 02 — Reconcile POLARIS.md

Identical in behavior to `polaris-reconcile` step 02. See
`.polaris/skills/polaris-reconcile/steps/02-reconcile-polaris-md.md` for full detail.

## Summary

For each folder in `work_inventory.affected_folders`:
1. Assess which files changed and how they affect the folder's operational reality.
2. Read the current POLARIS.md.
3. Apply the confidence threshold (≥0.85 write, 0.70–0.84 write with note, <0.70 skip).
4. Write the full updated POLARIS.md if needed — full replacement, not append.
5. Record in `polaris_md_updates`.

POLARIS.md is NOT a changelog. Replace stale statements with current truth.

## Output

```yaml
polaris_md_updates: [
  { file: "<path>", action: "update", change_summary: "<≤50 words>" },
  ...
]
```

## Next step

03-reconcile-summary-md
