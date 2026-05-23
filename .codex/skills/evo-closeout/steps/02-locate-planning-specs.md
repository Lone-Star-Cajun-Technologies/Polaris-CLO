---
name: evo-closeout-step-02-locate-planning-specs
description: Identify the scope from the issue and locate the related planning spec files.
---

# Step 02 — Locate planning specs

## Purpose

Establish the implementation scope and find the spec files that closeout will verify against.

## Scope declarations

```yaml
allowed_files:
  - docs/EVOnotes/planning-specs/**/*.md
  - issue and PR links that name planning specs
  - nearest INSTRUCTIONS.md for planning-spec paths
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-closeout/chain.md
  - docs/EVOnotes/planning-specs/**/*.md
allowed_skills:
  - none
expected_evidence:
  - candidate planning specs listed
  - active spec selected or missing-spec gap recorded
  - spec freshness assessed
stop_rules:
  - multiple specs conflict
  - spec file says not to update
  - no spec can be tied to delivered work
```
## Actions

From the parent issue description and child issues:

1. Extract the intended implementation scope.
2. Locate the related planning spec(s) in `docs/EVOnotes/planning-specs/`.
3. Locate any referenced raw docs in `docs/raw/`.
4. Note the `lifecycle_status`, `implementation_status`, `domain_lifecycle`, and `gitnexus_verified` frontmatter fields.

If no planning spec is found: report the gap and ask the user to provide the spec path before proceeding. Do not advance to step 03.

## Artifact update

**If planning spec was found:**

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `planning_spec: <path>`
- `last_completed_step: 02-locate-planning-specs`
- `next_step: 03-read-linked-prs`

**If no planning spec found:**

Update `.taskchain_artifacts/evo-closeout/current-state.json`:
- `planning_spec: not found`
- `status: waiting_for_confirmation`

Do NOT update `last_completed_step` or `next_step`.

## Next step

03-read-linked-prs (only when planning spec path is known)
