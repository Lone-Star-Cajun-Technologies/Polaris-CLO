---
name: polaris-run-step-05-validate-child
description: Run narrow validation scoped only to files changed in step 04; no broad builds or test suites.
---

# Step 05 — Validate child

## Purpose

Confirm the current child's changes are correct without generating broad validation noise.

## Scope declarations

```yaml
allowed_files:
  - changed files from current child
  - test, lint, or build config needed for narrow validation
  - .taskchain_artifacts/polaris-run/current-state.json
allowed_routes:
  - CLAUDE.md
  - .codex/skills/polaris-run/chain.md
expected_evidence:
  - narrowest useful validation command recorded
  - validation result tied to current child scope
  - unvalidated items explicitly listed
stop_rules:
  - validation command cannot run for environment reasons
  - validation failure is outside child scope
```

## Actions

1. Run narrow validation scoped only to the files changed in step 04.
2. Do not run broad test suites — those belong in step 08.
3. If validation fails: investigate within the child's scope, fix, and re-validate narrowly.
4. If the failure is outside the child's scope: note it as a follow-up and proceed.
5. Record the validation result:
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

Emit `step-complete` for `05-validate-child` to telemetry JSONL.

## Next step

06-commit-and-update-linear
