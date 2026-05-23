---
name: evo-closeout-step-04-gitnexus-graph-check
description: Verify the GitNexus implementation graph reflects the changes made during the cluster execution.
---

# Step 04 — GitNexus graph check

## Purpose

Confirm that the code changes are consistent with the planning spec scope and that no unexpected downstream effects were introduced.

## Scope declarations

```yaml
allowed_files:
  - GitNexus query/context/impact results for changed symbols
  - changed files from linked PRs
  - nearest INSTRUCTIONS.md for changed paths
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - gitnexus
expected_evidence:
  - graph impact summarized
  - unexpected downstream risk flagged
  - direct inspection fallback recorded if index stale
stop_rules:
  - GitNexus reports HIGH or CRITICAL unresolved impact
  - index stale and direct inspection cannot cover risk
  - changed symbols cannot be identified
```
## Actions

Use `gitnexus_impact` and `gitnexus_context` to verify:

1. Symbols and files touched by the implementation are consistent with the planning spec scope.
2. No unexpected callers or downstream effects appear in the graph that were not addressed.
3. The execution flows referenced in the planning spec are covered by the implementation.

If the GitNexus index was not refreshed after the implementation commits:
- Mark closeout as `closeout_blocked` or `closeout_partial`.
- Run `npx gitnexus analyze` and re-check before unblocking.

## Artifact update

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `gitnexus_status: <confirmed-fresh | stale-at-closeout | refreshed>`
- `last_completed_step: 04-gitnexus-graph-check`
- `next_step: 05-compare-planned-vs-implemented`

## Next step

05-compare-planned-vs-implemented
