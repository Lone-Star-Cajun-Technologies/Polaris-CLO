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

`.polaris/skills/` is the canonical source for all Polaris runtime workflow doctrine (step order, telemetry cadence, worker spawn rules, map update rules, checkpoint boundaries). Claude skill files in `.claude/skills/` are **thin invocation wrappers** only — they route Claude to the correct canonical skill and carry the CLI invocation mechanics. Do not duplicate Polaris doctrine in Claude skill files.

Agent-specific skill folders (`.claude/skills/`, `.codex/skills/`, `.gemini/skills/`, `.github/skills/`) all contain thin wrappers that redirect to `.polaris/skills/`.

| Claude skill | Canonical skill | Purpose |
|---|---|---|
| `skills/polaris-run.md` | `.polaris/skills/polaris-run/SKILL.md` | Invoke `polaris run`; runtime doctrine in canonical skill |
| `skills/polaris-loop.md` | `.polaris/skills/polaris-run/SKILL.md` | Invoke `polaris loop continue/status`; checkpoint doctrine in canonical skill |
| `skills/polaris-status.md` | `.polaris/skills/polaris-tools/SKILL.md` | Invoke `polaris status`; tool behaviour in canonical skill |

## Rebuild after changes

```bash
npm run build   # recompile src/ → dist/
```

`npm link` points at `dist/`, so a rebuild is all that is needed after source changes.
