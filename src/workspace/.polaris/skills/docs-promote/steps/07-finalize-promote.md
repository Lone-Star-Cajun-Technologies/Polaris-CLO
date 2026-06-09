---
name: docs-promote-step-07-finalize-promote
description: Emit completion telemetry, mark the run complete, and print the promotion summary.
---

# Step 07 — Finalize promote

## Purpose

Close out the session cleanly. Emit telemetry. Write final state. Report.

## Actions

1. **Emit `docs-promote-complete` telemetry**.

2. **Update `current-state.json`**:
   - `status: complete`
   - `current_step_id: 07-finalize-promote`
   - `completed_at: <ISO timestamp>`

3. **Print promotion summary**:

```text
**docs-promote complete**
Promoted:    <file> → <destination>  (one line per promoted file)
Deprecated:  <file> → <destination>  (one line per deprecated file)
Held:        <file> — <reason>       (one line per held/deferred file)
Errors:      none | <detail>
```

## Completion rule

Do not report complete until `current-state.json` has `status: complete`.

## Scope

```yaml
allowed_files:
  - .taskchain_artifacts/docs-promote/current-state.json
```

## Artifact update

Emit `step-complete` for `07-finalize-promote` and `docs-promote-complete` to telemetry JSONL.
