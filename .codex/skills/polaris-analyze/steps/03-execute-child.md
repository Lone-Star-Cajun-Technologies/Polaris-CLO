---
name: polaris-analyze-step-03-execute-child
description: Produce the analysis output for the active child — docs, specs, and planning files only.
---

# Step 03 — Execute child

## Purpose

Produce the analysis artifact for the active child issue. No source code changes.

## Scope declarations

```yaml
allowed_files:
  - docs/**
  - docs/spec/**
  - docs/planning/**
  - docs/Polaris/**
expected_evidence:
  - Linear issue fetched and scope confirmed
  - analysis artifact produced (doc, spec, or planning file)
stop_rules:
  - child scope requires source code changes (blocker — abort)
  - child is blocked by an unresolved external dependency
```

## Actions

1. Fetch the active child's Linear issue to read its full scope and deliverables.
2. Produce the analysis output. Allowed outputs:
   - Docs (`docs/`)
   - Specs (`docs/spec/`, `docs/Polaris/spec/`)
   - Planning files (`docs/planning/`, `docs/Polaris/planning/`)
   - Linear issue updates (findings, notes, links)
3. Do not modify `src/`, test files, config files, or `.polaris/` state files.
4. Do not commit yet — commit happens in step 04.

### Blocker protocol

If the child cannot proceed:

```
polaris loop abort "<reason>"
```

Report the blocker and the condition needed to unblock. Halt.

## Artifact update

No artifact update required at this step. Update happens after commit in step 04.

## Next step

04-commit-and-update-linear
