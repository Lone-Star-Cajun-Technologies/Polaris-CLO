---
name: polaris-run
description: Execute a Polaris implementation cluster — one governed session, bounded child execution, per chain.yaml definition.
---

# polaris-run

Use this skill when the user asks to run a Polaris implementation cluster. All children must be `session_type: implement`, or an analyze→implement boundary must have been crossed in a prior polaris-analyze session.

## How to execute

1. Read `chain.md` — it is the route map for this workflow.
2. Read `.polaris/runs/current-state.json` — it holds shared runtime state across sessions.
3. Execute one step at a time in the order chain.md specifies.
4. After each step completes, update `.polaris/runs/current-state.json` before advancing.
5. Do not skip steps.
6. Do not report completion until `.polaris/runs/current-state.json` has `status: complete`.

## Hard rules

- Implementation work only — source code, tests, config changes.
- One child per commit. Never batch multiple children into one commit.
- Do not call `polaris loop continue` without a preceding commit.
- Do not call `polaris finalize` until all children are Done.
