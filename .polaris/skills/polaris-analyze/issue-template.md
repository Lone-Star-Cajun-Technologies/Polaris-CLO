---
name: polaris-linear-issue-template
description: Canonical Linear issue template for Polaris implementation issues. Use for both IMPLEMENT parent issues and child implementation issues.
---

# Canonical Polaris Linear Issue Template

All implementation issues created by the `polaris-analyze` skill must use this exact structure.
Sections must appear in this order with these exact `##` headers.

## Why canonical format matters

The Polaris runtime parses issue bodies to derive `allowed_scope` and `validation_commands`
for worker packets. Non-canonical section names (e.g. "Implementation scope", "Expected code areas")
cause `allowed_scope` to be empty, which triggers the preflight gate and halts execution.

---

## Template

```markdown
## Objective
Short statement of what this issue accomplishes.

## Context
Why this issue exists. Include relevant bug, PR, cluster, or doctrine context.
Link to the ANALYZE source issue and any related issues.

## Goal
Specific implementation outcome.

## Scope
Machine-readable list of allowed paths or areas. Use explicit repo paths or globs.

- src/loop/**
- src/finalize/**
- src/cluster-state/**
- src/loop/parent.test.ts

## Acceptance Criteria

- [ ] Observable completion requirement 1
- [ ] Observable completion requirement 2
- [ ] Tests pass

## Validation

Commands that must be run:

- npm run build
- npm test
- npx vitest run src/loop src/finalize src/cluster-state

## Ordering

Dependencies or sequencing relative to sibling issues:

- Depends on <child-id> being Done first (or "None").

## Non-goals

What this issue must not change:

- Do not modify <area>.
- Do not change <schema/API/etc>.
```

---

## Rules

### Section names

Use the headers above exactly. Do NOT use:

| Non-canonical (do not use)  | Canonical         |
|-----------------------------|-------------------|
| Implementation scope        | `## Scope`        |
| Expected code areas         | `## Scope`        |
| Code areas                  | `## Scope`        |
| Files to change             | `## Scope`        |
| Test commands               | `## Validation`   |
| Verify                      | `## Validation`   |
| Requirements                | `## Acceptance Criteria` |
| Dependencies / Blockers     | `## Ordering`     |
| Out of scope                | `## Non-goals`    |
| Allowed Changes             | *(merge into Scope)* |

Aliases are supported by the body parser for backward compatibility, but new issues
must always use the canonical header names.

### `## Scope` is required

- Every implementation child issue MUST have `## Scope` with at least one path or glob.
- Child issues must include their own explicit `## Scope` section (they may not omit it).
- The runtime derives `allowed_scope` from the child's `## Scope` section. An empty or missing `## Scope` causes
  a hard preflight failure — the issue cannot be dispatched.
- If scope is not yet determinable, write:

  ```markdown
  ## Scope
  - TBD — BLOCKED: scope missing
  ```

  Then mark the Linear issue as **Blocked** status. The blocked status prevents dispatch.
  Do NOT invent paths or use placeholder globs like `src/**`.

### `## Validation` is required

Every implementation issue must list the commands that confirm acceptance criteria are met.
Minimum: `npm run build` and `npm test`.

### Full bodies required

Neither IMPLEMENT parent issues nor child issues may be title-only stubs. Every issue
must include all 8 canonical sections, populated with real content.

### IMPLEMENT parents

IMPLEMENT parent issues must include a cluster-wide `## Scope` section for documentation
and context purposes. However, every child issue must include its own explicit `## Scope`
section — children may not omit scope to inherit from the parent.

---

## Checklist before marking analysis Done

- [ ] Every IMPLEMENT child has a full body (not title-only)
- [ ] Every child has `## Scope` with real paths (not `TBD — BLOCKED`)
- [ ] Every child has `## Validation` with runnable commands
- [ ] Issues with unknown scope are marked Blocked in Linear
- [ ] IMPLEMENT parent has a full body with cluster-wide `## Scope`
- [ ] `clusters.json` references the IMPLEMENT parent as `source_id`
