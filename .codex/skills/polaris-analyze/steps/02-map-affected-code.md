---
name: polaris-analyze-step-02-map-affected-code
description: Use GitNexus to map the files, symbols, and execution flows affected by the issue scope.
---

# Step 02 — Map affected code

## Purpose

Identify the files, symbols, and execution flows relevant to the issue before assessing feasibility or decomposition.

## Scope declarations

```yaml
allowed_files:
  - files named in Linear issue
  - nearest POLARIS.md or INSTRUCTIONS.md for named paths
  - GitNexus query and context results for issue concepts
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-analyze/chain.md
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
3. Inspect only files relevant to the issue scope.
4. Check the Polaris atlas (`polaris map query <path>`) for route and domain context on affected files.
5. Record the files and execution flows inspected.

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `files_inspected: [<list of files/flows>]`
- `current_step_id: 02-map-affected-code`
- `updated_at: <timestamp>`

Emit `step-complete` for `02-map-affected-code` to telemetry JSONL.

## Next step

03-assess-issue
