---
name: evo-analyze-step-02-map-affected-code
description: Use GitNexus to map the files, symbols, and execution flows affected by the issue scope.
---

# Step 02 — Map affected code

## Purpose

Identify the files, symbols, and execution flows relevant to the issue before assessing feasibility or decomposition.

## Scope declarations

```yaml
allowed_files:
  - files named in Linear issue
  - nearest INSTRUCTIONS.md for named paths
  - GitNexus query/context results for issue concepts
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-analyze/chain.md
allowed_skills:
  - gitnexus
expected_evidence:
  - affected files and symbols listed
  - impact and execution-flow evidence recorded
  - unknown surfaces called out
stop_rules:
  - issue has no mappable code surface
  - GitNexus result is stale and cannot be refreshed
  - mapping requires broad unrelated traversal
```
## Actions

1. Use GitNexus for targeted inspection only — query concepts relevant to the issue scope. Do not summarize the whole repo.
2. Use `gitnexus_impact` and `gitnexus_context` for specific symbols mentioned in the issue.
3. Inspect only files relevant to the issue scope. Do not read unrelated files.
4. Record the files and execution flows inspected.

## Artifact update

Update `.taskchain_artifacts/evo-analyze/current-state.json`:
- `files_inspected: [<list of files / flows inspected>]`
- `last_completed_step: 02-map-affected-code`
- `next_step: 03-assess-issue`

## Next step

03-assess-issue
