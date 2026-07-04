# polaris - Codex plugin

Codex plugin that exposes governed Polaris skill wrappers and compact, read-only status helpers within a Codex worker session.

The skill wrappers are thin routing surfaces. They read `.polaris/skills/ROUTING.md`, load the canonical `.polaris/skills/<target-skill>/SKILL.md`, run the authorized skill packet bootloader, and then follow the canonical `chain.md`. They do not implement a parallel Polaris runtime.

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
npm run polaris -- --version
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
| `polaris_status` | `polaris status --json` | Compact current run summary (no full state dump) |
| `polaris_loop_status` | `polaris loop status --json` | Compact loop subsystem summary (no full state dump) |

`polaris_run` and `polaris_loop_continue` are recognized only as operator-only legacy names and return an error without invoking the CLI. The public CLI does not expose `polaris run`, and `polaris loop continue` is mutating: it checkpoints state and writes a bootstrap packet. Use the governed operator workflow for continuation.

The MCP safety model exposes `polaris_loop_continue_dry_run` and `polaris_loop_continue_confirmed` as a separate approval-envelope flow. This plugin helper does not wrap those as casual CLI commands unless a true non-mutating CLI dry-run is added.

`polaris finalize` remains manual/operator-only. Do not expose finalize as a normal Codex plugin tool until a confirmed finalize approval flow exists.

## Available skills

| Skill | Canonical target | Bootloader | Description |
|------|------------------|------------|-------------|
| `$polaris-run` | `.polaris/skills/polaris-run/` | `polaris skill packet run <cluster_id>` | Execute a governed Polaris run cluster |
| `$polaris-analyze` | `.polaris/skills/polaris-analyze/` | `polaris skill packet analyze <cluster_id>` | Analyze an issue and produce an implementation plan |
| `$polaris-finalize` | `.polaris/skills/polaris-run/` | `polaris skill packet run` | Enter the Foreman final-delivery path for the active run |
| `$polaris-reconcile` | `.polaris/skills/polaris-reconcile/` | `polaris skill packet reconcile <target>` | Reconcile packet-scoped project cognition |
| `$polaris-catalog` | `.polaris/skills/polaris-catalog/` | `polaris skill packet catalog <cluster_id>` | Catalog cognition and SmartDocs through a packet |
| `$docs-ingest` | `.polaris/skills/docs-ingest/` | `polaris skill packet ingest` | Ingest raw SmartDocs documents |
| `$docs-promote` | `.polaris/skills/docs-promote/` | `polaris skill packet promote` | Review and promote candidate SmartDocs |
| `$polaris-tools` | `.codex/plugins/polaris/skills/polaris-tools/` | n/a | Read-only compact status helper |

All user-facing Polaris skill commands must follow `.polaris/skills/ROUTING.md` before any repository inspection or runtime-state reads.

## Status helper usage from Codex

Invoke the helper script from the repo root:

```bash
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_status
node .codex/plugins/polaris/skills/polaris-tools/tools.js polaris_loop_status
```

All tools return compact JSON on stdout. On error, exit code is non-zero and the JSON contains an `error` field.

## Output contract

Tools return only a compact JSON summary. They never dump the full `current-state.json` or worker transcript into chat. Text summaries are truncated to 600 characters.

## Binary discovery order

1. `polaris` on `PATH` (installed via `npm link` or `npm install -g`)
2. `npx --no-install polaris` (project-local install, no network fetch)
3. Clear error returned if neither resolves

## Security note

All CLI arguments are passed as explicit argument arrays via `spawnSync` — no shell string interpolation is used.
