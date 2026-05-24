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

## Usage

The bootstrap-run skill reads and writes this file to track execution state across sessions. It should be committed to preserve state between sessions.
