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
4. Write `.taskchain_artifacts/polaris-run/current-state.json` **only at checkpoint boundaries**: session start (step 01), after each child completes (step 07 via `polaris loop continue`), session end (step 08), and on blocking failure. Do NOT write state after steps 02, 03, 05, or any intermediate substep.
5. Do not skip steps.
6. Do not report completion until `.taskchain_artifacts/polaris-run/current-state.json` has `status: complete`.

## Artifact authority rule

`.taskchain_artifacts/polaris-run/current-state.json` is the authoritative run ledger, not an optional note.

A **child completion** is not complete until `polaris loop continue` has written the checkpoint successfully.

Do not write state for orientation, branch prep, child selection, validation substeps, Linear reads, or individual command execution. These are read-only substeps.

If a checkpoint write fails or cannot be verified, stop and report the failure instead of continuing.

## Hard rules

- Implementation work only — source code, tests, config changes.
- One child per commit. Never batch multiple children into one commit.
- Do not call `polaris loop continue` without a preceding commit.
- `polaris finalize` replaces manual push and PR — do not push or open PRs directly.
- **Worker spawn guard**: for narrow, single-repo children, execute directly in the active worktree/branch. Do not spawn a worker unless the working tree is dirty in a risky way, the child is cross-cutting, parallelism is needed, the user explicitly requests isolation, or the child is high-risk. If a worker is spawned, record a short reason in the session-start or child-completion checkpoint.
- **Linear update cadence**: only update Linear when a child completes or a blocker is found. Avoid duplicate comments, repeated state churn, and mid-step Linear updates.
- **Map update**: run `polaris map update --changed` **once at session end** (step 08), never after individual children. Do not run it mid-loop.
