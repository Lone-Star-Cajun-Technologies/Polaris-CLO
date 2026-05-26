---
name: polaris-analyze-step-02-map-affected-code
description: Use the configured repo-analysis provider (if available) or the fallback path to map the files, symbols, and execution flows affected by the issue scope.
---

# Step 02 — Map affected code

## Purpose

Identify the files, symbols, and execution flows relevant to the issue before assessing feasibility or decomposition.

## Scope declarations

```yaml
allowed_files:
  - files named in Linear issue
  - nearest POLARIS.md or INSTRUCTIONS.md for named paths
  - repo-analysis provider query results for issue concepts (when provider is available)
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-analyze/chain.md
allowed_skills:
  - repo-analysis
expected_evidence:
  - affected files and symbols listed
  - impact and execution-flow evidence recorded
  - unknown surfaces called out
stop_rules:
  - issue has no mappable code surface
  - repo-analysis provider result is stale and cannot be refreshed (only when provider is in use; if unavailable use fallback)
  - mapping requires broad unrelated traversal
```

## Actions

1. Check `repo_analysis_status` from the step 01 artifact.
2. **If provider is available:** use it for targeted inspection only — query concepts relevant to the issue scope. Use impact analysis and context queries for specific symbols mentioned in the issue. Do not summarize the whole repo.
3. **If provider is unavailable (fallback path):**
   - Use `npm run polaris -- map query <path>` for route/domain/taskchain context on affected files
   - Use `rg <symbol>` for symbol and pattern location across the repo
   - Use direct file inspection for implementation details
   - The fallback path is always sufficient to complete the analysis.
4. Always run `npm run polaris -- map query <path>` for each affected file — it provides Polaris-specific routing context regardless of whether a provider is also in use.
5. Inspect only files relevant to the issue scope.
6. Record the files and execution flows inspected.

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `files_inspected: [<list of files/flows>]`
- `current_step_id: 02-map-affected-code`
- `updated_at: <timestamp>`

Emit `step-complete` for `02-map-affected-code` to telemetry JSONL.

## Next step

03-assess-issue
