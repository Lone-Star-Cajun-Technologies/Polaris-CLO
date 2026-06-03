---
name: closeout-librarian-step-03
description: Refresh SUMMARY.md to reflect current project state after the completed cluster.
---

# Step 03 — Reconcile SUMMARY.md

## Purpose

SUMMARY.md files serve as continuation artifacts, project snapshots, and handoff documents.
A future session loading SUMMARY.md must be able to continue work immediately without
replaying history.

The goal is that SUMMARY.md reflects the current state of the project AFTER this cluster,
not a log of what happened.

## What SUMMARY.md Represents

- Current understanding of the system (what is true now)
- Canonical references to active specs and doctrine
- Architecture snapshots that are no longer in flux
- Handoff context for continuation sessions

SUMMARY.md is NOT:
- A changelog
- A history of execution events
- A list of completed issues

## When to Update

Update a folder's SUMMARY.md when:
- Linked specs or doctrine changed significantly (new authoritative documents promoted)
- Canon relationships changed (new spec supersedes old; architecture changed)
- Architecture meaning changed in ways not captured by POLARIS.md
- Current understanding described in SUMMARY.md is now stale or contradicted by completed work

Do NOT update for: ephemeral execution events, minor bug fixes, test additions without
behavior change, changes that do not affect the reader's understanding.

## Reconciliation Principles

### Remove Stale Information

Identify statements in SUMMARY.md that are contradicted by the completed work.
Remove or replace them. Do not preserve stale content by appending "as of cluster X".

### Replace Superseded Information

When a spec or decision that SUMMARY.md references has been superseded, update the reference
to point to the current authority.

### Preserve Current Understanding

Retain content that accurately describes current reality. Preservation is not append — it is
selection of what remains true.

### Root-level SUMMARY.md

The root-level SUMMARY.md (if in `packet.affected_folders`) must reflect the overall project
state after this cluster. This is the primary continuation artifact for the whole project.
Give it higher priority than folder-level SUMMARY.md files.

## Actions

For each folder in `work_inventory.affected_folders` that has a SUMMARY.md:

### 3.1 Assess Staleness

1. Read the current SUMMARY.md (from `work_inventory.summary_md_files`).
2. Cross-reference with completed work: changed specs, new capabilities, new constraints.
3. Identify sections that are stale, contradicted, or superseded.
4. Identify new information that should be captured (architecture snapshots, spec promotions).

### 3.2 Refresh

Produce the updated SUMMARY.md content:
1. Remove sections that are no longer accurate.
2. Update references to specs and doctrine that changed.
3. Add brief architecture notes for significant new capabilities (if they help future sessions).
4. Ensure the document still reads as a coherent current-state snapshot, not a list of events.

**Constraint:** SUMMARY.md updates must not exceed `packet.constraints.max_summary_addition_lines`
net new lines per folder (default: 50 lines). Replacements do not count toward this limit.

### 3.3 Write

1. Verify the SUMMARY.md path is in `packet.allowed_write_paths`.
2. Write the full updated content.
3. Record in the running `summary_md_updates` list.

If no update is needed, record no-change for this folder.

## Output

Running list for step 08:
```
summary_md_updates: [
  { file: "<path>", action: "update", change_summary: "<≤50 words>" },
  ...
]
```

Proceed to step 04.
