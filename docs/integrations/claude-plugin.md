# Claude Plugin for Polaris

## What It Is

The Polaris Claude plugin is the `.claude/` directory in this repository.
Claude Code automatically loads skills from `.claude/skills/` when opened in
this repo — no separate installation step is needed.

This is the Claude Code plugin surface. Claude Desktop has a different plugin
model (MCP-based) not covered here. See Open Questions below.

## Skills Exposed

| Skill file | Slash command | What it invokes |
|---|---|---|
| `skills/polaris-status.md` | `/polaris-status` | `polaris status` |
| `skills/polaris-run.md` | `/polaris-run` | `polaris run` |
| `skills/polaris-loop.md` | `/polaris-loop` | `polaris loop continue` or `polaris loop status` |

## Installation

### Option A — npm link (recommended for local development)

```bash
cd /path/to/Polaris
npm install
npm run build
npm link
```

Verify:
```bash
polaris status
```

Expected output: Loop status table printed from `.taskchain_artifacts/polaris-run/current-state.json`.

### Option B — repo-local (no global install)

```bash
node /path/to/Polaris/dist/cli/index.js status
```

To use with the skills, set `POLARIS_BIN`:
```bash
export POLARIS_BIN="node /path/to/Polaris/dist/cli/index.js"
```

## How Invocation Works

```
Claude Code (user types /polaris-status)
  → Claude reads .claude/skills/polaris-status.md
  → Skill instructions tell Claude to call the polaris binary
  → Claude uses its Bash tool to run: polaris status
  → Output is returned to the user
```

No MCP server is required for Claude Code. The skills are markdown instruction
files. Claude executes shell commands using its built-in Bash tool.

## Smoke Test

After `npm link`:

```bash
# Safe read-only check — proves the full invocation path
polaris status

# JSON output — for programmatic verification
polaris status --json

# Note: --dry-run is not yet wired for loop continue (ContinueOptions has no dryRun field).
# Do not run loop continue as a smoke test — it mutates state, telemetry, map data, and bootstrap artifacts.
# Status-only smoke tests above are sufficient to prove the invocation path.
```

Both `polaris status` and `polaris status --json` smoke-test commands must exit 0.

## Runtime Architecture Compliance

The plugin is thin by design:

- Skills expose commands and call the `polaris` binary.
- The binary delegates to `src/loop/` and `src/finalize/` — Polaris owns the loop.
- Skills do not parse or mutate `current-state.json` directly.
- Chat context is not treated as execution memory.

## Open Questions / Blockers

1. **Claude Desktop**: The `.claude/skills/` mechanism is Claude Code only.
   Claude Desktop uses a different plugin model. If Polaris needs a Claude
   Desktop integration, an MCP server wrapper is likely required. This is a
   follow-up item.

2. **`polaris run` is stubbed**: `polaris run` prints `[polaris] run — not yet
   implemented (Cluster 4)`. Full run execution is a Cluster 4 deliverable.

3. **`polaris loop continue` calls `runLoopContinue`**: This is wired and
   mutating. Do not invoke it as a smoke test or preview unless a true dry-run
   path has been implemented and verified.

4. **Provider neutrality**: The plugin routes to Polaris runtime. Polaris
   manages provider selection. The plugin does not hardcode Claude.
