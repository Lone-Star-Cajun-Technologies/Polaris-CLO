---
name: polaris-run
description: Execute one governed Polaris Linear parent cluster per fresh session, with explicit child dispatch boundaries and post-child checkpointing.
role: foreman
role_file: .polaris/roles/foreman.md
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
4. After each durable checkpoint, update `.taskchain_artifacts/polaris-run/current-state.json` before advancing.
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

## Runtime-enforced dispatch boundaries

**The runtime enforces dispatch boundaries. Parent/orchestrator inline implementation is forbidden.**

The Polaris runtime tracks a `dispatch_boundary` record in `current-state.json` with monotonic epoch counters:

```json
{
  "dispatch_boundary": {
    "dispatch_epoch": 1,
    "continue_epoch": 0,
    "last_dispatched_child": "POL-23"
  }
}
```

### Enforcement rules

- `polaris loop continue` **will hard-fail** if `dispatch_epoch === continue_epoch` (no dispatch preceded this call).
- `polaris loop dispatch` **will hard-fail** if `active_child` is already set (previous dispatch not completed).
- `polaris loop run` (parent loop) **will hard-fail** if `active_child` is set at the start of a dispatch iteration.

These are not warnings. They are runtime errors with `process.exit(1)`.

### Allowed state machine transitions

```
idle           → dispatched        (polaris loop dispatch)
checkpointed   → dispatched        (polaris loop dispatch, next child)
dispatched     → worker-completed  (worker CompactReturn)
worker-completed → checkpointed    (polaris loop continue)
dispatched     → checkpointed      (polaris loop continue when worker wrote own completion)
checkpointed   → cluster-complete  (polaris loop continue, no remaining children)
*              → blocked           (polaris loop abort)
```

### Disallowed transitions (runtime-rejected)

```
idle           → worker-completed  (worker completed without dispatch)
idle           → checkpointed      (continue called without dispatch)
idle           → cluster-complete  (cluster done without dispatch path)
selected       → completed         (inline completion — forbidden)
selected       → checkpointed      (checkpoint without dispatch — forbidden)
```

### Telemetry events emitted on violation

| Event | When |
|---|---|
| `dispatch-required` | `polaris loop continue` called without prior dispatch |
| `invalid-inline-attempt` | `polaris loop dispatch` called with `active_child` already set |
| `illegal-state-transition` | Parent tries to complete child without dispatch boundary |

These events are append-only to `telemetry.jsonl` and appear only on failure paths.
