---
name: polaris-run
description: Execute one governed Polaris Linear parent cluster per fresh session, with bounded child execution, Polaris loop checkpointing, and map indexing after each child.
---

# polaris-run

Use this skill when the user asks to run a governed Polaris implementation cluster or standalone Polaris issue.

polaris-run only targets IMPLEMENT parents. If Step 01 detects a parent title
starting with `ANALYZE:` or an `analyze` label, halt with:
`polaris-run targets IMPLEMENT parents, not ANALYZE issues. Run polaris-analyze first to create an IMPLEMENT parent.`

## Related doctrine

See `docs/Polaris/spec/polaris-implementation-plan.md` for the Polaris architecture reference.

## How to execute

1. Read `chain.md` — it is the route map for this workflow.
2. Read `.taskchain_artifacts/polaris-run/current-state.json` — it holds shared runtime state across sessions.
3. Execute one step at a time in the order `chain.md` specifies.
4. After each step completes, update `.taskchain_artifacts/polaris-run/current-state.json` before advancing.
5. Do not skip steps.
6. Do not report completion until `.taskchain_artifacts/polaris-run/current-state.json` has `status: complete`.

## Artifact authority rule

`.taskchain_artifacts/polaris-run/current-state.json` is the authoritative run ledger, not an optional note.

A step is not complete until its state update has been written successfully.

If the artifact update fails or cannot be verified, stop and report the artifact failure instead of continuing.

## Hard rules

- Implementation work only — source code, tests, config changes.
- One child per commit. Never batch multiple children into one commit.
- Do not implement child work inline in the parent. Use `polaris loop dispatch` to dispatch a worker.
- `polaris loop continue` is post-child only. Do not call it before the worker has returned.
- Do not call `polaris loop continue` without a preceding commit.
- `polaris finalize` replaces manual push and PR — do not push or open PRs directly.
