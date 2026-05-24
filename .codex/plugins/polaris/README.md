# polaris — Codex plugin

Codex plugin that exposes Polaris CLI commands as tools within a Codex worker session. Provides `polaris_run`, `polaris_loop_continue`, and `polaris_status` without dumping large state files into context.

## Installation prerequisite

The Polaris CLI must be installed and resolvable before this plugin will work.

### Option A — link from the repo (development)

```bash
# From the Polaris repo root:
npm run build
npm link
```

After `npm link`, `polaris` is available globally on your PATH.

### Option B — install globally

```bash
npm install -g polaris
```

### Verify

```bash
polaris --version
```

If the binary is not found, the skill will attempt `npx --no-install polaris` as a fallback. If that also fails, the tool returns a clear error with install instructions.

## Installing the plugin in Codex

This plugin lives at `.codex/plugins/polaris/` inside the Polaris repo. To make it available in Codex:

1. Complete the `npm link` prerequisite above.
2. Open Codex and navigate to Plugins.
3. Install the plugin from the local path: `<repo-root>/.codex/plugins/polaris`.

No additional configuration is required beyond `npm link`.

## Available tools

| Tool | CLI equivalent | Description |
|------|---------------|-------------|
| `polaris_run` | `polaris run <issue_id>` | Start or resume a Polaris implementation run |
| `polaris_loop_continue` | `polaris loop continue [--provider p]` | Checkpoint state and advance the loop |
| `polaris_status` | `polaris loop status` | Compact status summary (no full state dump) |

## Usage from Codex

Invoke the helper script from the repo root:

```bash
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_run POL-42
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_loop_continue
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_loop_continue anthropic
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_status
```

All tools return compact JSON on stdout. On error, exit code is non-zero and the JSON contains an `error` field.

## Output contract

Tools return only a compact JSON summary. They never dump the full `current-state.json` or worker transcript into chat. The `summary` field is truncated to 300 characters (600 for `polaris_status`).

## Binary discovery order

1. `polaris` on `PATH` (installed via `npm link` or `npm install -g`)
2. `npx --no-install polaris` (project-local install, no network fetch)
3. Clear error returned if neither resolves

## Security note

All CLI arguments are passed as explicit argument arrays via `spawnSync` — no shell string interpolation is used.
