---
name: polaris-reconcile-step-02
description: Update affected POLARIS.md files to accurately reflect the current state of each folder after the completed work.
---

# Step 02 — Reconcile POLARIS.md

## Purpose

Each affected folder's POLARIS.md must accurately describe the current reality of that folder.
This step performs actual reconciliation — not append-only notes.

## What POLARIS.md Represents

A folder's POLARIS.md is a living operational guide. It should describe:
- Current capabilities (what this folder does now)
- Current architecture (how it is structured now)
- Current responsibilities (what owns what)
- Current constraints (what is forbidden)
- Current folder state (what is present and what is not)

POLARIS.md is NOT a changelog. Do not append "added in POL-123". Replace stale
statements with current truth.

## When to Update

Update a folder's POLARIS.md when ALL of the following are true:
1. Files in that folder were changed by the completed work.
2. The changes materially affect the folder's responsibilities, architecture, or constraints.
3. The current POLARIS.md content is factually wrong or incomplete as a result.

Do NOT update for: formatting fixes, test additions without behavior change,
internal refactors that leave operational guidance still accurate.

## When NOT to Update

- The folder was not touched by the completed work.
- The changes are in sub-packages that have their own POLARIS.md.
- The existing POLARIS.md correctly describes the outcome of the changes.

## Actions

For each folder in `work_inventory.affected_folders`:

### 2.1 Assess the Impact

1. Identify which files in this folder were changed (from `work_inventory.all_changed_files`).
2. Read the current POLARIS.md content for this folder (from `work_inventory.polaris_md_files`).
3. Read cognition notes for this folder (from `work_inventory.pending_cognition_notes`).
4. Cross-reference with child summaries and work summary to understand what changed.

### 2.2 Determine Required Changes

For each stale or missing statement in POLARIS.md:
- If a capability was added: add it to the appropriate section.
- If a capability was changed: update the statement in place.
- If a capability was removed: remove the statement.
- If a constraint was added: add to constraints section.
- If a constraint was lifted: remove it.
- If architecture changed: update the architecture description.

**Reconciliation principle:** The resulting POLARIS.md must describe the folder as it
exists AFTER the work completed. Read the code if necessary to confirm the current state.

### 2.3 Confidence Threshold

Assess confidence (0.0–1.0) in the proposed update:
- `≥ 0.85`: Apply the update.
- `0.70–0.84`: Apply with a note in the result that confidence was moderate.
- `< 0.70`: Skip the update for this folder, record as a blocker in the result.

Low confidence triggers: ambiguous changed_files, contradictory notes, minimal diff context.

### 2.4 Write

If the assessment confirms an update is needed and confidence is sufficient:
1. Verify the POLARIS.md path is in `packet.allowed_write_paths`.
2. Write the full updated content (not a patch — full file replacement).
3. Record in the running `polaris_md_updates` list.

If the path is in `packet.prohibited_write_paths`, record as a blocker and skip.

## Output

Running list for step 04:
```yaml
polaris_md_updates: [
  { file: "<path>", action: "update", change_summary: "<≤50 words>" },
  ...
]
```

## Next step

03-reconcile-summary-md
