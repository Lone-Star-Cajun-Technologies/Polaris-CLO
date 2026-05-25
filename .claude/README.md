# Polaris — Claude Plugin

Claude Code skills that invoke the local Polaris CLI. The skills use the `polaris` binary, which must be available on `PATH` before use.

## Setup

### Option A — npm link (recommended for local development)

```bash
# From the Polaris repo root:
npm install
npm run build
npm link
```

`npm link` registers `polaris` as a global symlink. The binary at `dist/cli/index.js` is then reachable as `polaris` in any shell session on this machine.

Verify:

```bash
polaris run
# → [polaris] run — not yet implemented (Cluster 4)
```

### Option B — local path (no global install)

Invoke directly without linking:

```bash
node /path/to/Polaris/dist/cli/index.js run
node /path/to/Polaris/dist/cli/index.js loop continue
node /path/to/Polaris/dist/cli/index.js loop status
```

To use Option B with the Claude skills, override the `POLARIS_BIN` env var:

```bash
export POLARIS_BIN="node /path/to/Polaris/dist/cli/index.js"
```

The skills fall back to `polaris` if `POLARIS_BIN` is not set.

## Unlinking

```bash
npm unlink -g polaris
```

## Skills

| Skill file | Slash command | What it does |
|---|---|---|
| `skills/polaris-run.md` | `/polaris-run` | Invoke `polaris run` |
| `skills/polaris-loop.md` | `/polaris-loop` | Invoke `polaris loop continue` or `polaris loop status` |

## Rebuild after changes

```bash
npm run build   # recompile src/ → dist/
```

`npm link` points at `dist/`, so a rebuild is all that is needed after source changes.
