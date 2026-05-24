# polaris-tools skill

Claude Code skill that exposes Polaris CLI commands as callable tools without dumping large state into chat context.

## Installation prerequisite

The Polaris CLI must be installed and resolvable before this skill will work.

### Option A — link from the repo (development)

```bash
# From the Polaris repo root:
npm run build
npm link
```

After `npm link`, `polaris` is available globally on your `PATH`.

### Option B — install globally

```bash
npm install -g polaris
```

### Verify

```bash
polaris --version
```

If the binary is not found, the skill will attempt `npx --no-install polaris` as a fallback. If that also fails, the tool returns a clear error with install instructions.

## Available tools

| Tool | CLI equivalent | Description |
|------|---------------|-------------|
| `polaris_run` | `polaris run <issue_id>` | Start or resume a Polaris implementation run |
| `polaris_loop_continue` | `polaris loop continue [--provider p]` | Checkpoint state and advance the loop |
| `polaris_status` | `polaris loop status` | Compact status summary (no full state dump) |

## Usage from Claude Code

Invoke the helper script from the repo root:

```bash
node .codex/skills/polaris-tools/tools.js polaris_run POL-71
node .codex/skills/polaris-tools/tools.js polaris_loop_continue
node .codex/skills/polaris-tools/tools.js polaris_loop_continue anthropic
node .codex/skills/polaris-tools/tools.js polaris_status
```

All tools return compact JSON on stdout. On error, exit code is non-zero and the JSON contains an `error` field.

## Output contract

Tools return only a compact JSON summary. They never dump the full `current-state.json` or worker transcript into chat. The `summary` field is truncated to 300 characters (600 for `polaris_status`).

## Security note

All CLI arguments are passed as explicit argument arrays via `spawnSync` — no shell string interpolation is used.
