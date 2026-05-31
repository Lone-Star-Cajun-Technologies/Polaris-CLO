---
name: polaris-tools
description: Exposes compact read-only Polaris status helpers within a Codex session. Direct run, ungated loop continuation, and finalize remain operator-only.
---

# polaris-tools

Use this skill when the user wants to inspect Polaris run state without dumping large artifacts:
- `polaris status --json` / compact current-state summary → `polaris_status`
- `polaris loop status --json` / compact current-state summary → `polaris_loop_status`

Do not use this skill as a casual mutation surface. `polaris_run` and `polaris_loop_continue` are operator-only legacy names in the helper and return an error without invoking the CLI. Finalize is manual/operator-only until a confirmed finalize approval flow exists.

## Prerequisites

The Polaris CLI must be installed before using this skill. See `README.md` in the plugin root for installation steps.

## Tool behaviours

### polaris_status()

Attempts `polaris status --json`. If the CLI is not available, reads and summarises
`.taskchain_artifacts/polaris-run/current-state.json` compactly. Returns:
```json
{
  "tool": "polaris_status",
  "run_id": "...",
  "cluster_id": "...",
  "status": "...",
  "active_child": null,
  "next_open_child": "...",
  "completed_children": [...],
  "open_children": [...],
  "updated_at": "..."
}
```

### polaris_loop_status()

Attempts `polaris loop status --json`. If the CLI is not available, reads and summarises
`.taskchain_artifacts/polaris-run/current-state.json` compactly. Returns the same compact shape with `"tool": "polaris_loop_status"`.

### Operator-only names

`polaris_run(issue_id)` and `polaris_loop_continue(provider?)` are not exposed as casual helpers. They return:
```json
{"tool":"polaris_loop_continue","error":"operator_only","message":"..."}
```

The MCP safety model has a separate `polaris_loop_continue_dry_run` / `polaris_loop_continue_confirmed` approval-envelope flow. This helper does not wrap continuation unless a true non-mutating CLI dry-run is added.

Never dump the full state file into chat.

## How to invoke

Run the helper script from the repo root:

```
node .codex/plugins/polaris/skills/polaris-tools/tools.js <tool> [args...]
```

Examples:
```
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_status
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_loop_status
```

The script prints compact JSON to stdout and exits 0 on success, non-zero on error.

## Discovery order for the Polaris binary

1. `polaris` on `PATH` (installed via `npm link` or `npm install -g`)
2. `npx --no-install polaris` (project-local install)
3. Error emitted clearly if neither resolves

## Error format

```json
{"error":"polaris binary not found. Install via: npm link (from repo root) or npm install -g polaris","tool":"<tool>"}
```
