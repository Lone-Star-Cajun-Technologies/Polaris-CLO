---
kind: spec
status: active
implements: 
related: 
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: src/tracker/schema.ts,src/config/schema.ts
---

# Bootstrap current-state.json Schema

**Note:** This is the bootstrap schema for the temporary `bootstrap-run` skill. The full Polaris current-state schema (used by `polaris loop`) will be richer and will be documented in a future `docs/spec/polaris-architecture-spec.md` spec.

## Schema

```json
{
  "schema_version": "1.0",
  "run_id": "",
  "cluster_id": "",
  "active_child": "",
  "completed_children": [],
  "open_children": [],
  "step_cursor": "",
  "context_budget": {
    "children_completed": 0,
    "max_children_per_session": 3
  },
  "status": "not-started"
}
```

## Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `schema_version` | string | Schema version identifier |
| `run_id` | string | Unique identifier for the current run |
| `cluster_id` | string | Linear ID of the parent cluster being executed |
| `active_child` | string | Linear ID of the child currently being executed |
| `completed_children` | array | List of Linear IDs of children completed in this run |
| `open_children` | array | List of Linear IDs of children still open (not Done) |
| `step_cursor` | string | Current step in the bootstrap-run chain |
| `context_budget.children_completed` | number | Number of children completed in this session |
| `context_budget.max_children_per_session` | number | Maximum children allowed per session (default: 3) |
| `status` | string | Run status: not-started, running, stopped, complete |

## Budget config fields (polaris.config.json)

The `budget` section of `polaris.config.json` controls how the parent loop enforces child dispatch limits. When absent, the default behavior is a 3-child fixed-cap (backwards compatible with `max_children_per_session: 3`).

```json
{
  "budget": {
    "mode": "fixed-cap",
    "max_children": 3,
    "stop_on_fail": false,
    "allow_analyze_children": false
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `budget.mode` | string | `"fixed-cap"` | Enforcement mode: `"fixed-cap"`, `"run-until-done"`, or `"stop-on-fail"` |
| `budget.max_children` | number | `3` | Max children per session (only enforced in `fixed-cap` mode) |
| `budget.stop_on_fail` | boolean | `false` | If true, halt immediately when any child returns `status: "failed"` |
| `budget.allow_analyze_children` | boolean | `false` | If true, allow analyze-type children in an impl session |

### Modes

- **`fixed-cap`** (default): stop after `max_children` children complete. Equivalent to the old hardcoded `max_children_per_session: 3`.
- **`run-until-done`**: run all open children without a count cap. Ignores `max_children`.
- **`stop-on-fail`**: no count cap, but halt immediately when any child returns `status: "failed"`. Implies `stop_on_fail: true`.

The `stop_on_fail` flag can be combined with any mode for fail-fast behavior.

## Usage

The bootstrap-run skill reads and writes this file to track execution state across sessions. It should be committed to preserve state between sessions.
