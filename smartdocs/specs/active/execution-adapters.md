---
kind: spec
status: active
implements: 
related: 
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: src/loop/execution-adapter.ts
---

# Polaris Execution Adapters

## Overview

Polaris dispatches child tasks to external agents through a pluggable **adapter** system. Each adapter defines how to invoke an agent, what information to pass, and how to collect results. Adapters are provider-neutral — they know nothing about the specific agent (Codex, Gemini, Claude, Windsurf). Providers are configured separately.

This document covers the `terminal-cli` adapter (the first implemented adapter) and documents the planned `agent-subtask` adapter for Claude-native workflows.

---

## Key Design Principles

- **One child per dispatch.** Each `polaris loop continue` invocation dispatches exactly one active child and returns. The parent selects the next child on the following invocation.
- **No parallelism.** Dispatches are sequential. Provider rotation does not run multiple providers simultaneously.
- **Provider-neutral.** The adapter does not know or care which AI system it is calling. Configuration is the only coupling point.
- **State via shared branch.** External agents do not share chat context. They share state via the git branch (current-state.json, telemetry.jsonl, committed code).

---

## `terminal-cli` Adapter

Invokes a configured external CLI tool as a subprocess. Suitable for any agent that can be run from a terminal: Codex, Gemini, Windsurf (when it can run shell commands), and custom scripts.

### How it works

1. Reads `active_child` from the current-state file.
2. Builds a **bootstrap packet** (compact JSON) with all context the worker needs.
3. Writes the packet to a temp file and sets env vars.
4. Spawns the configured command with the packet delivered via:
   - **stdin** (JSON, always)
   - `POLARIS_PACKET_FILE` env var (path to temp file)
   - `POLARIS_PACKET_JSON` env var (raw JSON string)
   - Individual `POLARIS_*` env vars for common fields
5. Captures stdout; parses the last JSON line as a worker summary.
6. Returns dispatch result to the parent.

### Bootstrap Packet

```json
{
  "schema_version": "1.0",
  "run_id": "run-abc123-def4",
  "cluster_id": "POL-5",
  "active_child": "POL-14",
  "state_file": "/path/to/.taskchain_artifacts/bootstrap-run/current-state.json",
  "telemetry_file": "/path/to/.taskchain_artifacts/bootstrap-run/telemetry.jsonl"
}
```

### Worker Responsibilities

The external worker **must**:

1. Read the bootstrap packet (from stdin or env vars).
2. Execute **only** the child task identified by `active_child`.
3. Update `state_file` (current-state.json) when done.
4. Append one entry to `telemetry_file` (JSONL).
5. Write a compact JSON summary as the **last line of stdout**:
   ```json
   {"active_child":"POL-14","status":"done","message":"Completed implementation"}
   ```
6. Exit with code 0 on success, non-zero on failure.

### Configuration

Add an `execution` block to `polaris.config.json`:

```json
{
  "execution": {
    "adapter": "terminal-cli",
    "providers": {
      "codex": { "command": "codex", "args": [] },
      "gemini": { "command": "gemini", "args": [] },
      "custom": { "command": "$POLARIS_AGENT" }
    },
    "rotation": ["codex", "gemini"],
    "allowCrossAgentFallback": false
  }
}
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `adapter` | string | Adapter to use. Currently only `terminal-cli`. |
| `providers` | object | Named provider configs. |
| `providers.<name>.command` | string | Executable name or absolute path. Supports `$ENV_VAR` expansion. |
| `providers.<name>.args` | string[] | CLI arguments. Supports `{{template}}` variable substitution. |
| `rotation` | string[] | Ordered provider list. First entry is default when `--provider` is not specified. |
| `allowCrossAgentFallback` | boolean | Reserved. Always `false` — no automatic fallback on failure. |

### Template Variables in `args`

| Variable | Value |
|---|---|
| `{{active_child}}` | The child task ID being dispatched (e.g. `POL-14`) |
| `{{run_id}}` | Current run ID |
| `{{cluster_id}}` | Parent cluster ID |
| `{{state_file}}` | Absolute path to current-state.json |
| `{{telemetry_file}}` | Absolute path to telemetry JSONL file |
| `{{packet_json}}` | Full bootstrap packet as a JSON string |
| `{{packet_file}}` | Path to temp file containing bootstrap packet JSON |

---

## CLI Reference

```
polaris loop continue [options]
```

**Options:**

| Flag | Description |
|---|---|
| `--adapter <name>` | Adapter to use. Overrides `polaris.config.json`. |
| `--provider codex` | Dispatch to the `codex` provider. |
| `--provider gemini` | Dispatch to the `gemini` provider. |
| `--provider custom` | Dispatch to the `custom` provider (uses `$POLARIS_AGENT`). |
| `--provider <any>` | Dispatch to any configured provider by name. |
| `--dry-run` | Print the exact dispatch command without running it. |
| `--state-file <path>` | Path to current-state.json. |

**Examples:**

```bash
# Dispatch using config defaults (rotation[0])
polaris loop continue

# Dispatch to a specific provider
polaris loop continue --provider codex
polaris loop continue --provider gemini
polaris loop continue --provider custom

# Preview dispatch without running
polaris loop continue --provider codex --dry-run

# Override adapter on the command line
polaris loop continue --adapter terminal-cli --provider gemini

# Use a non-default state file
polaris loop continue --state-file .polaris/runs/my-run/current-state.json
```

---

## Provider-Specific Notes

### Codex

```json
"codex": { "command": "codex", "args": [] }
```

Codex reads the bootstrap packet from `POLARIS_PACKET_FILE` or stdin. Configure your Codex system prompt to read the packet and execute exactly one child task.

### Gemini / Antigravity

```json
"gemini": { "command": "gemini", "args": ["--prompt", "Execute Polaris child {{active_child}}. Packet: {{packet_file}}"] }
```

If the Gemini CLI migration renames the binary (`antigravity` or similar), update the `command` field — no code changes required.

### Custom / Windsurf / Other

```json
"custom": { "command": "$POLARIS_AGENT" }
```

Set `POLARIS_AGENT=/path/to/your/agent` before running `polaris loop continue --provider custom`. This works for any agent that can be invoked as a CLI tool.

**Windsurf as orchestrator:** Windsurf may act as the parent orchestrator if it can run shell commands. In that case, Windsurf calls `polaris loop continue --provider <name>` to delegate each child to a terminal-cli worker (Codex, Gemini, etc.).

---

## Planned: `agent-subtask` Adapter

The `agent-subtask` adapter will enable Claude-native subagent workflows as a first-class execution mode. It is **not yet implemented**. When added, it will:

- Launch a Claude subagent via the Agent SDK.
- Pass the bootstrap packet to the subagent's system prompt.
- Collect the subagent's output as the dispatch result.
- Enable Claude Code → Claude subagent dispatch without any shell subprocess.

**Configuration (future):**

```json
{
  "execution": {
    "adapter": "agent-subtask",
    "providers": {
      "claude": {
        "model": "claude-opus-4-7",
        "systemPrompt": "You are a Polaris worker. Execute exactly one child task..."
      }
    }
  }
}
```

Until `agent-subtask` is implemented, Claude Code can use `terminal-cli` with the `claude` CLI (if available) or a custom wrapper script.

---

## Isolation Model

External agents dispatched via `terminal-cli` are **process-isolated**. They:

- Do **not** share the parent's chat context or memory.
- Share state exclusively through the git branch:
  - `current-state.json` — task tracking
  - `telemetry.jsonl` — execution telemetry
  - Committed code changes
- Must commit their changes and exit before the parent resumes.

This isolation is intentional. It allows any combination of agents (Codex + Gemini + Claude + custom scripts) to work on the same taskchain without requiring shared context or a common provider SDK.

---

## Error Handling

| Condition | Behaviour |
|---|---|
| Provider not in config | Error: "Unknown provider X. Available: codex, gemini" |
| Provider `command` is unset `$VAR` | Error: "looks like an unset environment variable" |
| Provider command not found on PATH | Error: "not found on PATH. Install it or update command field." |
| Worker exits non-zero | Polaris forwards the exit code; no automatic retry |
| `allowCrossAgentFallback: false` | No fallback; parent decides what to do after failure |
