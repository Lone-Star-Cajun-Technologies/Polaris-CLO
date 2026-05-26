# Issue Hierarchy Doctrine

## Purpose

Polaris separates analysis from execution with a two-parent issue hierarchy:

- The ANALYZE issue is the research and planning parent.
- The IMPLEMENT parent is the governed execution parent that `polaris-run` targets.

This split keeps analysis deliverables stable, keeps implementation children under a single executable parent, and prevents an analysis issue from becoming the direct execution cluster.

## ANALYZE Issue Purpose

An ANALYZE issue exists to investigate a problem, compare options, define scope, and produce an implementation plan. It may contain research notes, risks, acceptance criteria, proposed child issues, and links to canonical specs.

An ANALYZE issue must not be the direct parent for executable implementation children. It may link to the IMPLEMENT parent it produced, but it remains the analysis record.

Put these under the ANALYZE issue:

- Problem statement and background.
- Research findings and tradeoffs.
- Proposed architecture or migration strategy.
- Acceptance criteria for the implementation cluster.
- Link to the created IMPLEMENT parent.

## IMPLEMENT Parent Purpose

An IMPLEMENT parent is the execution cluster root. It contains the ordered implementation children that `polaris-run` may execute one at a time.

The IMPLEMENT parent is the only parent issue that should appear as the active execution cluster in `clusters.json`. `polaris-run` targets the IMPLEMENT parent, not the ANALYZE issue.

Put these under the IMPLEMENT parent:

- Ordered IMPLEMENT child issues.
- Child dependency edges and blocker relationships.
- Execution-scoped acceptance criteria.
- The branch name used for the implementation cluster.
- Delivery notes, run evidence, and final PR linkage.

## Required Structure

Every analyzed implementation cluster must use this structure:

```text
ANALYZE parent
  -> IMPLEMENT parent
       -> IMPLEMENT child 1
       -> IMPLEMENT child 2
       -> IMPLEMENT child N
```

The ANALYZE parent may block or relate to the IMPLEMENT parent, depending on Linear workflow needs, but executable children belong to the IMPLEMENT parent.

## `polaris-analyze` Responsibilities

`polaris-analyze` creates the IMPLEMENT parent after the analysis deliverable is accepted for execution. The created IMPLEMENT parent must include:

- A title beginning with `IMPLEMENT:`.
- A concise execution summary.
- The ordered child issue list.
- Dependency and blocker notes.
- A `gitBranchName` derived from the IMPLEMENT parent.

After creating the IMPLEMENT parent, `polaris-analyze` points `clusters.json` at that IMPLEMENT parent. It must not point `clusters.json` at the ANALYZE issue when the cluster is intended for `polaris-run`.

## `polaris-run` Responsibilities

`polaris-run` accepts an IMPLEMENT parent as its execution target. During orientation, it should reject an ANALYZE issue when that issue is being used as the direct execution parent and report that the operator must run against the IMPLEMENT parent instead.

When the current parent is valid, `polaris-run` executes only the lowest-numbered open child under that IMPLEMENT parent, updates the run ledger, records telemetry, and stops or hands off after one completed child according to the run chain.

## Naming Convention

IMPLEMENT parent titles use this form:

```text
IMPLEMENT: <imperative cluster summary>
```

Child titles use this form:

```text
IMPLEMENT: <specific executable task>
```

The IMPLEMENT parent `gitBranchName` should be derived from the IMPLEMENT parent identifier and title:

```text
<user-or-agent>/<implement-parent-id-lowercase>-<slugified-implement-title>
```

Example:

```text
philmeaux/pol-105-implement-issue-hierarchy-and-ephemeral-execution-refactor
```

The branch belongs to the IMPLEMENT parent, not to the ANALYZE issue. Child commits on that branch use child-scoped commit prefixes such as `[POL-106]`.

## Migration Guide

Some existing clusters use the ANALYZE issue as the direct execution parent. Migrate those clusters before running new implementation work:

1. Identify the ANALYZE issue that currently owns executable children.
2. Create a new IMPLEMENT parent with the accepted execution scope from the analysis.
3. Move or recreate executable children under the IMPLEMENT parent in their intended order.
4. Preserve dependency and blocker relationships on the moved children.
5. Set the IMPLEMENT parent `gitBranchName` using the naming convention above.
6. Update `clusters.json` so the cluster entry points at the IMPLEMENT parent.
7. Add a comment on the ANALYZE issue linking to the IMPLEMENT parent and explaining that execution moved.
8. Run `polaris-run` against the IMPLEMENT parent only.

If implementation already started under the ANALYZE issue, keep existing commits, move the remaining open children under the IMPLEMENT parent, and record the migration in both issue comments. Do not silently continue execution under the ANALYZE parent.
