# polaris-tools skill

Codex skill that exposes compact, read-only Polaris status helpers without dumping large state into chat context.

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
| `polaris_status` | `polaris status --json` | Compact current run summary (no full state dump) |
| `polaris_loop_status` | `polaris loop status --json` | Compact loop subsystem summary (no full state dump) |

`polaris_run` and `polaris_loop_continue` are recognized only as operator-only legacy names and return an error without invoking the CLI. The public CLI does not expose `polaris run`, and `polaris loop continue` is mutating: it checkpoints state and writes a bootstrap packet.

The MCP safety model exposes `polaris_loop_continue_dry_run` and `polaris_loop_continue_confirmed` as a separate approval-envelope flow. This helper does not wrap continuation unless a true non-mutating CLI dry-run is added.

`polaris finalize` remains manual/operator-only. Do not expose finalize as a normal tool until a confirmed finalize approval flow exists.

## Usage from Codex

Invoke the helper script from the repo root:

```bash
node .polaris/skills/polaris-tools/tools.js polaris_status
node .polaris/skills/polaris-tools/tools.js polaris_loop_status
```

All tools return compact JSON on stdout. On error, exit code is non-zero and the JSON contains an `error` field.

## Output contract

Tools return only a compact JSON summary. They never dump the full `current-state.json` or worker transcript into chat. Text summaries are truncated to 600 characters.

## Security note

All CLI arguments are passed as explicit argument arrays via `spawnSync` — no shell string interpolation is used.
