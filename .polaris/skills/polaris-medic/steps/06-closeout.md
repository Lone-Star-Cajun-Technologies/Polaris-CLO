---
name: polaris-medic-step-06
description: Commit repair changes, write sealed result, and terminate.
---

# Step 06 — Closeout

## Purpose

Commit all changes from this session (repairs and chart), write the sealed result, and terminate. This is the final step.

## Actions

### 6.1 Determine Commit Strategy

Based on the work completed:
- If repairs were made and/or chart was created: create a commit
- If no changes were made (e.g., diagnosis deferred): do not create a commit

### 6.2 Create Commit (if changes exist)

If changes were made:
1. Stage all modified files
2. Create a commit with message:

```
[POL-326] Medic: <brief description of repair>

Generated with [Devin](https://cli.devin.ai/docs)

Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
```

3. Record the commit SHA

If no changes were made, set `commit_sha: null`.

### 6.3 Prepare Sealed Result

Prepare the sealed result JSON:

```json
{
  "run_id": "<from packet>",
  "dispatch_id": "<from packet>",
  "cluster_id": "<from packet>",
  "status": "<success | partial | failure | blocked>",
  "commit_sha": "<commit SHA or null>",
  "chart_id": "<chart ID or null>",
  "diagnosis": {
    "root_cause": "<root cause>",
    "repair_strategy": "<repair strategy>"
  },
  "validation": {
    "outcome": "<success | partial | failure>",
    "build_passed": <true | false>,
    "tests_passed": <true | false>
  },
  "blockers": [<any blockers encountered>],
  "timestamp": "<ISO8601 timestamp>"
}
```

Set status based on overall outcome:
- `success`: Repair completed, validation passed, chart created
- `partial`: Some work done, but blockers remain
- `failure`: Fatal error encountered
- `blocked`: All work blocked

### 6.4 Write Sealed Result

Write the sealed result JSON to `packet.result_path`.

If the write fails, output to stderr and terminate (cannot recover).

### 6.5 Emit Telemetry

Emit `medic-commit` event (if commit created) and `medic-complete` event (if telemetry path provided).

## Completion Criteria

- Commit created (if changes were made)
- Sealed result written to result_path
- Telemetry events emitted

Terminate session. No further steps.