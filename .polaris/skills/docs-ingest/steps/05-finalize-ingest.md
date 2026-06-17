---
name: docs-ingest-step-05-finalize-ingest
description: Emit completion telemetry, mark the cluster complete, update current-state, and report the placement summary.
---

# Step 05 — Finalize ingest

## Purpose

Close out the ingest session cleanly. Emit telemetry. Write final state. Report.

## Actions

1. **Emit `docs-ingest-complete` telemetry** for each processed file.

2. **Update cluster manifest** (`.polaris/docs-ingest/<cluster-id>.json`):
   - `status: complete`
   - `completedAt: <ISO timestamp>`

3. **Update `current-state.json`**:
   - `status: complete`
   - `current_step_id: 05-finalize-ingest`
   - `completed_at: <ISO timestamp>`

4. **Report placement summary**:
   ```text
   **docs-ingest complete**
   Processed:           <n> files
   Placed:
     <original> → <smartdocs/target>
     ...
   Pending user approval: <files requiring approval, if any> | none
   Conflicts:           <none | list with resolution required>
   Map updated:         yes | failed (<detail>)
   Next cluster:        <cluster-id> | none pending
   ```

5. **Bootstrap packet** — if more clusters remain pending in `.polaris/docs-ingest/`, emit guidance for the next session:
   ```text
   Next: polaris docs ingest --batch <next-cluster-id>
   ```

## Completion rule

Do not report session complete until `current-state.json` has `status: complete`.

## Artifact update

Emit `step-complete` for `05-finalize-ingest` and `docs-ingest-complete` to telemetry JSONL.
