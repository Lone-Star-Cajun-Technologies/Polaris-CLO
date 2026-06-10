---
name: docs-promote-step-03-read-linked-code
description: Read the linked source area for each candidate and assess whether the doc is current, stale, or superseded.
---

# Step 03 — Read linked code

## Purpose

Ground each candidate in the actual codebase. A doc that no longer matches its linked code area should not be promoted — it should be updated or discarded.

## Actions

For each candidate with a `linkedMapArea`:

1. **Read the linked area**:
   - Read `<linkedMapArea>/POLARIS.md` if present
   - Read up to 3 key source files in the area (prefer files named in the doc)

2. **Assess relevance**:
   - `current` — doc accurately describes what the code does
   - `stale` — code has evolved; doc's assumptions are partially outdated
   - `superseded` — the area no longer exists or has been fully replaced

3. **Record findings** — one verdict per candidate with a brief rationale (≤2 sentences).

For candidates with **no `linkedMapArea`**: mark as `unlinked` — cannot assess code relevance. Proceed; surface to user in step 05.

## Scope

```yaml
allowed_files:
  - <linkedMapArea>/ (read only — POLARIS.md and up to 3 source files)
  - .polaris/map/index.json (read only)
  - .taskchain_artifacts/docs-promote/current-state.json
stop_rules:
  - linked area not found in map (record as unlinked; do not halt)
```

## Artifact update

Update `current-state.json`:
- `current_step_id: 03-read-linked-code`
- Per candidate: `relevance: current|stale|superseded|unlinked`, `relevance_rationale: "..."`

Emit `step-complete` for `03-read-linked-code`.

## Next step

04-conflict-surface
