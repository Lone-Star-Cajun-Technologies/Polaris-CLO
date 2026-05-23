---
name: evo-analyze-step-05-create-child-issues
description: Create or update ordered child issues that evo-run can execute without ambiguity.
---

# Step 05 — Create child issues

## Purpose

Produce an ordered set of child issues that evo-run can execute in ascending numeric order without ambiguity.

## Scope declarations

```yaml
allowed_files:
  - assessment output from step 03
  - blocker output from step 04
  - Linear project/team metadata
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-analyze/chain.md
allowed_skills:
  - none
expected_evidence:
  - child issue drafts or created issues map to evidence-backed gaps
  - dependencies and acceptance criteria captured
  - parent relationship recorded
stop_rules:
  - user approval required for issue creation is missing
  - child boundary is not evidence-backed
  - blocked parent should not receive executable children
```
## Actions

**Before creating any child:**
- Check all existing child issues.
- If a matching child already exists, update/refine it instead of recreating.
- Do not create duplicates.

**Ordering rules:**
- Parent numbering: `[0]`, `[1]`, `[2]`
- Child numbering: `[Parent issueID.1]`, `[Parent issueID.2]`, `[Parent issueID.3]` (relative to parent)
- Blockers must come before dependents — no forward dependencies.
- Number children so `evo-run` can execute them in ascending numeric order.

**Each child issue must include all of the following sections:**

```text
## Objective
One sentence. What this child achieves when complete.

## Scope
Specific files, symbols, or systems this child touches.

## Allowed Changes
Exhaustive list of what may be modified. Anything not listed is out of scope.

## Out of Scope
Explicit exclusions. Prevents scope creep during evo-run execution.

## Acceptance Criteria
Verifiable conditions that must be true for this child to be marked Done.
Written as checkable assertions, not subjective descriptions.

## Validation
Commands or checks evo-run must run to confirm acceptance criteria pass.
Example: `npm test`, targeted test file, lint command, type check.

## Dependencies / Blockers
List any child issues that must be Done before this one can start.
Use child IDs (e.g., EVOC-XXX.1 must be Done before starting EVOC-XXX.2).
Omit this section if none.
```

## Artifact update

Update `.taskchain_artifacts/evo-analyze/current-state.json`:
- `child_issues: [<ID — title>, ...]`
- `last_completed_step: 05-create-child-issues`
- `next_step: 06-final-report`

## Next step

06-final-report
