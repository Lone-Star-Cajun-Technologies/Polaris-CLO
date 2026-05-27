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
polaris status --json
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

## Skill canonicality

`.codex/skills/` is the canonical source for all Polaris runtime workflow doctrine (step order, telemetry cadence, worker spawn rules, map update rules, checkpoint boundaries). Claude skill files in `.claude/skills/` are **thin invocation wrappers** only — they route Claude to the correct canonical Codex skill and carry the CLI invocation mechanics. Do not duplicate Polaris doctrine in Claude skill files.

| Claude skill | Canonical Codex skill | Purpose |
|---|---|---|
| `skills/polaris-run.md` | `.codex/skills/polaris-run/SKILL.md` | Invoke `polaris run`; runtime doctrine in Codex |
| `skills/polaris-loop.md` | `.codex/skills/polaris-run/SKILL.md` | Invoke `polaris loop continue/status`; checkpoint doctrine in Codex |
| `skills/polaris-status.md` | `.codex/skills/polaris-tools/SKILL.md` | Invoke `polaris status`; tool behaviour in Codex |

## Rebuild after changes

```bash
npm run build   # recompile src/ → dist/
```

`npm link` points at `dist/`, so a rebuild is all that is needed after source changes.
