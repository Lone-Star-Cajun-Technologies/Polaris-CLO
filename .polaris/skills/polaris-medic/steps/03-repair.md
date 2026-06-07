---
name: polaris-medic-step-03
description: Execute repair changes to implementation code based on diagnosis.
---

# Step 03 — Repair

## Purpose

Execute the repair strategy identified in step 02 to fix the failure. This step makes changes to implementation code only.

## Actions

### 3.1 Verify Write Permissions

Before making any changes, verify that the target files are in `packet.allowed_write_paths` and not in `packet.prohibited_write_paths`.

If a target file is prohibited, skip and record as a blocker.

### 3.2 Execute Repair Strategy

Apply the repair strategy determined in step 02:

- **Syntax errors**: Fix syntax in the identified files
- **Missing dependencies**: Add missing imports or dependencies
- **Type mismatches**: Correct type annotations
- **Logic errors**: Adjust the implementation logic
- **Test failures**: Update test expectations or fix implementation
- **Configuration errors**: Fix configuration files
- **Environment issues**: Document requirements (do not change environment)

Make the smallest scoped change that addresses the root cause.

### 3.3 Verify Repair Completeness

After applying the repair, verify:
- The identified root cause is addressed
- No new syntax errors are introduced
- Changes are within the scope of the failed child's work

If the repair cannot be completed (e.g., root cause unclear, changes too broad), record this as a blocker.

### 3.4 Record Changes

Record the changes made internally (not written to disk):

```yaml
repair_changes:
  files_modified: [<list of files>]
  changes_summary: <brief description of changes>
  blockers: [<any blockers encountered>]
```

### 3.5 Emit Telemetry

Emit `medic-step-complete` event for step 03 (if telemetry path provided).

## Completion Criteria

- Repair strategy executed (or blocked)
- Changes made are minimal and scoped
- No prohibited files were modified

Proceed to step 04.