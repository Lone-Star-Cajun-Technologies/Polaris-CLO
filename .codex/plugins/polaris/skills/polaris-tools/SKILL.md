---
name: polaris-tools
description: Exposes Polaris CLI commands as callable tools within a Codex session. Provides polaris_run, polaris_loop_continue, and polaris_status without dumping large state into chat context.
---

# polaris-tools

Use this skill when the user wants to invoke Polaris CLI commands:
- `polaris run <issue-id>` → `polaris_run`
- `polaris loop continue [--provider <provider>]` → `polaris_loop_continue`
- `polaris loop status` / compact current-state summary → `polaris_status`

## Prerequisites

The Polaris CLI must be installed before using this skill. See `README.md` in the plugin root for installation steps.

## Tool behaviours

### polaris_run(issue_id)

Invokes `polaris run <issue_id>` via the local shell. Returns compact JSON:
```json
{"tool":"polaris_run","issue_id":"<id>","exit_code":0,"summary":"<first 300 chars of stdout>"}
```

### polaris_loop_continue(provider?)

Invokes `polaris loop continue [--provider <provider>]` via the local shell. Returns compact JSON:
```json
{"tool":"polaris_loop_continue","provider":"<provider or null>","exit_code":0,"summary":"<first 300 chars of stdout>"}
```

### polaris_status()

Attempts `polaris loop status`. If that command is not available, reads and summarises
`.taskchain_artifacts/polaris-run/current-state.json` compactly. Returns:
```json
{
  "tool": "polaris_status",
  "run_id": "...",
  "status": "...",
  "active_child": "...",
  "completed_children": [...],
  "open_children": [...],
  "updated_at": "..."
}
```

Never dumps the full state file into chat.

## How to invoke

Run the helper script from the repo root:

```
node .codex/plugins/polaris/skills/polaris-tools/tools.js <tool> [args...]
```

Examples:
```
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_run POL-42
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_loop_continue
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_loop_continue anthropic
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_status
```

The script prints compact JSON to stdout and exits 0 on success, non-zero on error.

## Discovery order for the Polaris binary

1. `polaris` on `PATH` (installed via `npm link` or `npm install -g`)
2. `npx polaris` (project-local install)
3. Error emitted clearly if neither resolves

## Error format

```json
{"error":"polaris binary not found. Install via: npm link (from repo root) or npm install -g polaris","tool":"<tool>"}
```
