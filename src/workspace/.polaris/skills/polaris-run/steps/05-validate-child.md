---
name: polaris-run-step-05-validate-child
description: Validate the worker-returned child evidence and validation summary without re-implementing child work in the parent.
---

# Step 05 — Validate child

## Purpose

Confirm the worker's returned child evidence is correct without re-implementing child work in the parent.

## Scope declarations

```yaml
allowed_files:
  - changed files from current child
  - test, lint, or build config needed for narrow validation
  - .taskchain_artifacts/polaris-run/current-state.json
allowed_routes:
  - CLAUDE.md
  - .polaris/skills/polaris-run/chain.md
expected_evidence:
  - narrowest useful validation command recorded
  - validation result tied to current child scope
  - unvalidated items explicitly listed
stop_rules:
  - validation command cannot run for environment reasons
  - validation failure is outside child scope
```

## Actions

1. Validate the worker return packet for the active child (child ID, status, commit hash when applicable, and validation summary).
2. Do not implement fixes inline in the parent session. If changes are needed, dispatch a worker for the child scope.
3. Do not run broad test suites — those belong in step 08.
4. If validation fails and is within child scope: return to dispatch flow for worker remediation.
5. If the failure is outside child scope: note it as a follow-up and proceed.
6. Record the validation result:
   - **Status**: `passed` | `failed` | `skipped`
   - **Commands run**: names only (e.g., `npm run lint`, `npm test -- <file>`)
   - **Count**: N passed / M failed
   - **First error**: first failing check name only, if failed
   - **Maximum**: 5–10 lines total — no raw stdout/stderr

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:
- `validation_status: <passed | failed | skipped>`
- `current_step_id: 05-validate-child`
- `status: validating`
- `updated_at: <timestamp>`

Telemetry remains checkpoint-only. Do not emit per-step `step-complete` events.

## Next step

06-commit-and-update-linear
