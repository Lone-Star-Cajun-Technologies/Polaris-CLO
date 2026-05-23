---
name: evo-run-step-05-validate-child
description: Run narrow validation scoped only to files changed in step 04; no broad builds or test suites.
---

# Step 05 — Validate child

## Purpose

Confirm the current child's changes are correct without generating broad validation noise.

## Scope declarations

```yaml
allowed_files:
  - changed files from current child
  - nearest INSTRUCTIONS.md for validation commands
  - test, lint, or build configuration needed for narrow validation
  - .taskchain_artifacts/evo-run/current-state.json
allowed_routes:
  - .evo/routing.md
  - nearest INSTRUCTIONS.md for any file path being inspected or edited
  - .codex/skills/evo-run/chain.md
  - docs/EVOnotes/needs-review/governance/task-chain-composition-doctrine.md
allowed_skills: []
expected_evidence:
  - narrowest useful validation command recorded
  - validation result tied to current child scope
  - unvalidated items explicitly listed
stop_rules:
  - validation command cannot run for environment reasons
  - validation failure is outside child scope
  - required validation surface is ambiguous
```
## Actions

1. Run narrow validation scoped only to the files changed in step 04.
2. Do not run final builds or broad test suites — those belong in step 08.
3. Do not run parent-level validation until final delivery.
4. If validation fails: investigate within the child's scope. Fix and re-validate narrowly.
5. If validation failure is outside the child's scope, note it as a follow-up issue and proceed.
6. Record the validation result using the canonical summary format:
   - **Status**: `passed` | `failed` | `skipped`
   - **Commands run**: names only (e.g., `git diff --check`, `npm run lint`) — no raw output
   - **Count**: `N passed / M failed / K skipped` if applicable
   - **First error**: first failing check name or error line only, if failed
   - **Prohibited**: raw stdout/stderr, per-file lint listings, full test output, verbose build logs
   - **Maximum**: 5–10 lines total in `validation_status` and artifact `notes`

## Artifact update

After completing, update `.taskchain_artifacts/evo-run/current-state.json`:
- `validation_status: <passed | failed | skipped>`
- `current_step_id: 05-validate-child`
- `status: validating`
- `updated_at: <timestamp>`

## Next step

06-commit-and-update-linear
