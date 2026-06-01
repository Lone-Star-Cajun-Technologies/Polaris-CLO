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
  - .polaris/skills/polaris-analyze/chain.md
expected_evidence:
  - clusters.json written to .polaris/clusters/<implement-parent-id>/clusters.json
  - Linear IMPLEMENT parent issue created under the ANALYZE issue (tracker-backed)
  - Linear child issues created under the IMPLEMENT parent (tracker-backed) or task list updated (trackerless)
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

### 2. Create Linear IMPLEMENT parent issue (tracker-backed only)

Before creating any child issue, create or reuse a separate Linear IMPLEMENT parent issue:
- Title: `IMPLEMENT: <slug>`
- Parent: the ANALYZE source issue that produced this cluster plan
- Purpose: hold executable implementation children for `polaris-run`

If a matching IMPLEMENT parent already exists under the ANALYZE issue, update/refine it instead of duplicating it.

Children must be created under the IMPLEMENT parent, not under the ANALYZE issue.

**The IMPLEMENT parent MUST have a full body using the canonical format.** Title-only stubs are not allowed. Use:

```text
## Objective
One sentence. What this cluster accomplishes when complete.

## Context
Why this cluster was created. Link to ANALYZE source issue.

## Goal
The specific implementation outcome for the entire cluster.

## Scope
Cluster-wide allowed paths or globs for documentation purposes. Each child must include its own explicit ## Scope.
- <path-or-glob>
- ...

## Acceptance Criteria
- Verifiable conditions for the cluster as a whole.

## Validation
- <command>
- ...

## Ordering
Dependencies relative to other IMPLEMENT clusters, if any.

## Non-goals
What the cluster must not change.
```

### 3. Write clusters.json

Always write to `.polaris/clusters/<implement-parent-id>/clusters.json`.

Set `clusters.json` `source_id` to the IMPLEMENT parent issue ID, not the ANALYZE issue ID. Set `analyze_source_id` to the ANALYZE issue ID for traceability.

```json
{
  "source_id": "<Linear IMPLEMENT parent issue ID>",
  "analyze_source_id": "<Linear ANALYZE issue ID>",
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

### 4. Create Linear child issues (tracker-backed only)

**Before creating any child:**
- Check all existing child issues.
- If a matching child already exists, update/refine it — do not duplicate.
- Confirm the child parent is the IMPLEMENT parent issue.

**Every child issue MUST have a full body. Title-only stubs are not allowed.**

**Canonical child issue body format (use this exactly):**

```text
## Objective
One sentence. What this child achieves when complete.

## Context
Why this child exists. Include relevant bug, PR, cluster, or doctrine context.

## Goal
Specific implementation outcome for this child.

## Scope
Machine-readable list of allowed paths or globs. Use explicit repo paths.
- src/loop/**
- src/finalize/**

## Acceptance Criteria
- Verifiable condition 1
- Verifiable condition 2

## Validation
- npm run build
- npm test
- npx vitest run <relevant paths>

## Ordering
- List of sibling child IDs this child depends on (or "None").

## Non-goals
- What this child must not change.
```

**Critical rules for `## Scope`:**

- Use the header `## Scope` exactly — not "Implementation scope", "Expected code areas", "Files", or any other variant. Aliases exist for backward compatibility only; new issues must use `## Scope`.
- List explicit repo paths or globs, one per bullet.
- If scope is not yet determinable, write:
  ```
  ## Scope
  - TBD — BLOCKED: scope missing
  ```
  and mark the Linear issue as **Blocked** status. Do NOT invent paths. A blocked issue will not be dispatched by polaris-run.
- Do not omit the `## Scope` section. A missing scope section causes a hard preflight failure at dispatch time.

## Artifact update

Update `.taskchain_artifacts/polaris-analyze/current-state.json`:
- `clusters_file: ".polaris/clusters/<implement-parent-id>/clusters.json"`
- `child_issues: [<ID — title>, ...]`
- `current_step_id: 05-create-cluster-plan`
- `updated_at: <timestamp>`

Emit `step-complete` for `05-create-cluster-plan` to telemetry JSONL.

## Next step

06-final-report
