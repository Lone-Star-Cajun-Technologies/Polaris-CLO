---
name: docs-promote-step-06-execute-promote-deprecate
description: Execute the approved promote and deprecate CLI commands one at a time. Halt on any failure.
---

# Step 06 — Execute promote / deprecate

## Purpose

Fire the CLI commands for every candidate the user approved. One command at a time. Record the result after each before continuing.

## Actions

For each candidate with `decision: approved`:

### Spec promotion
```bash
npm run polaris -- doctrine spec-promote <path> --approve
```

### Doctrine candidate promotion
```bash
npm run polaris -- doctrine promote <path>
```

### Active doctrine deprecation
```bash
npm run polaris -- doctrine deprecate <path>
```

After each command:
- Record `promoted_to` or `deprecated_to` path in state
- Emit `docs-promoted` telemetry with `file` and result path

If a command exits non-zero:
- **Halt immediately.** Do not attempt any remaining commands.
- Record the error in state under `execution_error`.
- Report the failure in full. Wait for user instruction.

Candidates with `decision: rejected` or `deferred`: skip. Record in state as `skipped`.

## Scope

```yaml
allowed_files:
  - smartdocs/raw/ (write — files will be moved by CLI)
  - smartdocs/doctrine/candidate/ (write — files will be moved by CLI)
  - smartdocs/doctrine/active/ (write — files will be moved by CLI)
  - smartdocs/specs/active/ (write — files will be moved by CLI)
  - .taskchain_artifacts/docs-promote/current-state.json
stop_rules:
  - any CLI command exits non-zero → halt immediately
```

## Artifact update

Update `current-state.json` after each command:
- `current_step_id: 06-execute-promote-deprecate`
- Per candidate: `promoted_to|deprecated_to|skipped`, `execution_error` if applicable

Emit `step-complete` for `06-execute-promote-deprecate` only after all approved candidates are processed (or halted).

## Next step

07-finalize-promote
