---
name: polaris-analyze
description: Execute a Polaris analysis cluster — produce specs, designs, and planning artifacts only. No source code changes.
---

# polaris-analyze

Use this skill when the user asks to run a Polaris analysis cluster. Children must be `session_type: analyze`. When all analyze children are Done, `polaris loop continue` enforces the analyze→implement boundary automatically — a fresh polaris-run session handles any subsequent implement children.

## How to execute

1. Read `chain.md` — it is the route map for this workflow.
2. Read `.polaris/runs/current-state.json` — it holds shared runtime state across sessions.
3. Execute one step at a time in the order chain.md specifies.
4. After each step completes, update `.polaris/runs/current-state.json` before advancing.
5. Do not skip steps.

## Hard rules

- Analysis and planning artifacts only (`docs/`, `docs/spec/`, `docs/planning/`).
- Never modify `src/`, test files, or config files.
- Never commit non-doc file changes in an analyze session.
- Do not call `polaris finalize` unless all cluster children — including any implement children that ran in a separate polaris-run session — are Done.
