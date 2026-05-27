# Claude Desktop MCP Integration

Polaris ships an MCP (Model Context Protocol) server that exposes read-only tools for inspecting run state. This lets Claude Desktop query a live Polaris session without needing shell access.

---

## Prerequisites

- Node.js 20 or later
- Polaris repo cloned locally
- Dependencies installed and project built:

```sh
npm install
npm run build
```

The compiled server will be at `dist/mcp/server.js` relative to the repo root.

---

## Config file location

Claude Desktop reads MCP server configuration from a JSON file. Location by OS:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` |

Create the file if it does not exist.

---

## Configuration

Add a `polaris` entry under `mcpServers`. Use **absolute paths** — Claude Desktop does not expand `~` or relative paths.

```json
{
  "mcpServers": {
    "polaris": {
      "command": "node",
      "args": ["/absolute/path/to/Polaris/dist/mcp/server.js"],
      "env": {
        "POLARIS_ROOT": "/absolute/path/to/Polaris"
      }
    }
  }
}
```

Replace `/absolute/path/to/Polaris` with the actual path on your machine. For example:

- macOS/Linux: `/Users/you/code/Polaris` or `/home/you/code/Polaris`
- Windows: `C:\Users\you\code\Polaris` (use forward slashes or escape backslashes in JSON)

If `claude_desktop_config.json` already has other `mcpServers` entries, merge the `polaris` key into the existing object rather than replacing the file.

---

## Step-by-step setup

**1. Build the server**

```sh
cd /path/to/Polaris
npm install
npm run build
```

Verify the output exists:

```sh
ls dist/mcp/server.js
```

**2. Edit the Claude Desktop config**

Open (or create) the config file for your OS (paths above). Add the `mcpServers.polaris` block shown in the Configuration section, substituting your actual repo path.

**3. Restart Claude Desktop**

Quit and relaunch the app. MCP servers are loaded at startup.

**4. Smoke test**

In a new conversation, ask:

> What Polaris tools do you have?

Claude should list `polaris_status`, `polaris_loop_status`, and `polaris_current_state`. If it does, the server is connected.

---

## Available tools

All three tools are read-only. They do not modify any Polaris state.

| Tool | Description |
|------|-------------|
| `polaris_status` | Returns the current loop run state by calling `polaris status --json`. Includes run ID, cluster ID, status, active child, step cursor, and context budget. |
| `polaris_loop_status` | Returns loop-scoped status by calling `polaris loop status --json`. Same fields as `polaris_status`, scoped to the loop subsystem. |
| `polaris_current_state` | Returns the parsed contents of `current-state.json` from `.taskchain_artifacts/`, with sensitive keys redacted. Accepts an optional `artifact_dir` parameter (default: `polaris-run`). |

---

## Troubleshooting

**"Server not found" / tool names do not appear**

- Confirm the path in `args` is absolute and points to `dist/mcp/server.js`.
- Run `npm run build` — the file must exist before Claude Desktop can load it.
- Restart Claude Desktop after editing the config.

**`state_not_found` error returned by a tool**

No active Polaris run exists yet. The state files are created when a cluster session runs. Start a Polaris session first, then retry.

**`Cannot locate Polaris repo root` error**

The server cannot find the repo. Set `POLARIS_ROOT` in the `env` block of your Claude Desktop config to the absolute path of the repo. See the Configuration section above.

**Config changes not taking effect**

Claude Desktop only reads the config on startup. Fully quit (not just close the window) and relaunch after any edit.

---

## What is not included

The current MCP server is intentionally read-only. Mutating operations — triggering runs, advancing state, writing artifacts — are not exposed. Adding write tools requires a separate design review and explicit approval. That work is tracked as future scope.
