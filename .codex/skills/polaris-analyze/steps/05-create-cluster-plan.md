---
name: polaris-analyze-step-05-create-cluster-plan
description: Create ordered child issues in the tracker (if tracker-backed) and generate a local clusters.json artifact for polaris-run to consume.
---

# Step 05 — Create cluster plan

## Purpose

Produce an ordered execution plan that polaris-run can execute without ambiguity. Always generate a local `clusters.json` artifact. For tracker-backed workflows, also create Linear child issues.

## Scope declarations

```yaml
allowed_files:
  - assessment output from steps 03-04
  - .polaris/clusters/<source-id>/clusters.json
  - docs/ (for any analysis docs produced)
  - Linear project/team metadata
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .codex/skills/polaris-analyze/chain.md
expected_evidence:
  - clusters.json written to .polaris/clusters/<source-id>/clusters.json
  - Linear child issues created (tracker-backed) or task list updated (trackerless)
  - execution ordering is unambiguous
  - no source code changes made
stop_rules:
  - cluster boundary is not evidence-backed
  - would require source code changes to produce the plan
  - blocked parent should not receive cluster plan
```

## Hard rules

- No source code (`src/`, tests, config) may be created or modified in this step.
- Cluster plans are analysis artifacts only.
- If source code changes are needed to plan: note them as findings in the plan — do not make them.

## Actions

### 1. Design execution clusters

Group the work into executable clusters. Each cluster maps to one polaris-run session.

Ordering rules:
- Clusters with no dependencies execute first.
- No forward dependencies within a cluster.
- Children within a cluster execute in ascending numeric/dependency order.
- Analyze-type children must precede implement-type children in mixed clusters.

Each child must have:
- `session_type`: `analyze` | `implement`
- `blockedBy`: list of child IDs that must be Done first (empty list if none)
- A well-scoped Linear issue body (see below) for tracker-backed workflows

### 2. Write clusters.json

Always write to `.polaris/clusters/<source-id>/clusters.json`:

```json
{
  "source_id": "<Linear parent issue ID>",
  "source_type": "linear",
  "created_at": "<ISO timestamp>",
  "clusters": [
    {
      "cluster_id": "cluster-01",
      "children": [
        {
          "id": "<Linear child issue ID or planned ID>",
          "title": "<child title>",
          "session_type": "analyze | implement",
          "blockedBy": []
        }
      ]
    }
  ]
}
```

For trackerless workflows (`source_type: "local"`), IDs are locally generated slugs. polaris-run reads from clusters.json rather than Linear.

### 3. Create Linear child issues (tracker-backed only)

**Before creating any child:**
- Check all existing child issues.
- If a matching child already exists, update/refine it — do not duplicate.

**Each child issue body must include:**

```text
## Objective
One sentence. What this child achieves when complete.

## Scope
Specific files, symbols, or systems this child touches.

## Allowed Changes
Exhaustive list of what may be modified.

## Out of Scope
Explicit exclusions.

## Acceptance Criteria
Verifiable conditions that must be true to mark Done.

## Validation
Commands polaris-run must run to confirm criteria pass.

## Dependencies / Blockers
Child IDs that must be Done before this one can start.
```

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `clusters_file: ".polaris/clusters/<source-id>/clusters.json"`
- `child_issues: [<ID — title>, ...]`
- `current_step_id: 05-create-cluster-plan`
- `updated_at: <timestamp>`

Emit `step-complete` for `05-create-cluster-plan` to telemetry JSONL.

## Next step

06-final-report
