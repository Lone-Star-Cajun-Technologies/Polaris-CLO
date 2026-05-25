# POL-76 Analysis: Claude Desktop MCP Bridge for Polaris Runtime

**Status:** Analysis complete — ready for implementation planning
**Issue:** POL-76
**Date:** 2026-05-25

---

## Executive Summary

A local MCP server is the correct and sufficient bridge between Claude Desktop and the Polaris runtime. The server should be a thin Node.js/TypeScript stdio process living in `src/mcp/`, exposing narrow read-only tools that call Polaris CLI commands via subprocess. The first slice delivers three read-only tools: `polaris_status`, `polaris_loop_status`, and `polaris_current_state`. Mutating tools come later, gated behind explicit approval boundaries.

The path is clear, the risk surface is manageable, and the architecture coexists cleanly with the existing Claude Code `.claude/skills/` surface.

---

## 1. MCP Feasibility Analysis for Claude Desktop

**Verdict: Fully feasible. MCP is the right mechanism.**

Claude Desktop supports the Model Context Protocol natively. Local MCP servers run as child processes communicating over stdio — no network stack, no authentication tokens, no port exposure. The protocol is stable (spec v1.0+) and the TypeScript SDK (`@modelcontextprotocol/sdk`) is mature and actively maintained.

Key constraints that make this the right fit:

| Constraint | How MCP handles it |
|---|---|
| Claude Desktop can't call arbitrary shell commands | MCP server owns the shell boundary — only its predefined tools are reachable |
| Need structured output | MCP tool responses are typed JSON — no raw terminal formatting |
| Need controlled tool surface | Server's tool registry is the complete list — no tool injection |
| Must coexist with Claude Code `.claude/skills/` | Completely separate invocation paths — no conflict |
| Must stay read-only initially | Server simply does not register mutating tools until approved |

**What MCP gives us that `.claude/skills/` does not:**
- Works in Claude Desktop (not just Claude Code CLI)
- Structured tool parameters and return values
- Tool discoverability via `tools/list`
- Clear capability boundary visible to the client

---

## 2. Proposed Minimum MCP Server Architecture

### Location

```
src/mcp/
├── server.ts          # MCP server entry point
├── tools/
│   ├── index.ts       # Tool registry
│   └── status.ts      # polaris_status tool handler
└── lib/
    ├── invoke.ts      # Safe subprocess invocation
    └── state.ts       # Direct state file reader (fallback path)
```

### Runtime model

```
Claude Desktop
  → claude_desktop_config.json (mcpServers.polaris)
  → spawn: node dist/mcp/server.js
  → MCP stdio transport
  → Tool: polaris_status
  → spawn: polaris status --json  (or node dist/cli.js status --json)
  → reads: .taskchain_artifacts/polaris-run/current-state.json
  → returns: compact structured JSON
```

### Stack

- **Runtime:** Node.js 20+, TypeScript 5+, ES2022, Node16 module system (consistent with Polaris)
- **MCP SDK:** `@modelcontextprotocol/sdk` (add to `package.json`)
- **Transport:** `StdioServerTransport` — required for Claude Desktop local process model
- **Build:** compile to `dist/mcp/server.js` via existing `npm run build`

### Server shape (pseudocode)

```typescript
// src/mcp/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./tools/index.js";
import { dispatchTool } from "./tools/index.js";

const server = new Server(
  { name: "polaris", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) =>
  dispatchTool(req.params.name, req.params.arguments ?? {})
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 3. Proposed First Read-Only Tool Contracts

### `polaris_status`

**Purpose:** Return the current Polaris loop run state.

**Input:** None (no parameters).

**Invocation:**
```bash
polaris status --json
# or fallback:
node dist/cli.js status --json
# or fallback (pure file read):
cat .taskchain_artifacts/polaris-run/current-state.json
```

**When to use which invocation path:** See §8 below.

---

### `polaris_loop_status`

**Purpose:** Explicit alias scoped to loop status. Identical to `polaris_status` in the first slice but provides a stable name for the loop-specific surface even if `polaris status` later aggregates multiple subsystems.

**Input:** None.

**Invocation:**
```bash
polaris loop status --json
```

---

### `polaris_current_state`

**Purpose:** Return the raw parsed current-state file, lightly redacted.

**Input:**
```json
{
  "artifact_dir": { "type": "string", "description": "Optional: artifact dir name. Default: polaris-run", "optional": true }
}
```

**Invocation:** Direct file read (no subprocess). Reads:
```
{repoRoot}/.taskchain_artifacts/{artifact_dir}/current-state.json
```

**Redaction rules:**
- Strip any key containing `secret`, `token`, `key`, `password`, `credential` (case-insensitive) — defensive against future schema additions
- Truncate array fields > 50 items

**Not in first slice:** `polaris_loop_continue_dry_run`, `polaris_run`, `polaris_loop_continue`, `polaris_finalize`

---

## 4. Proposed Tool Output Schemas

### Shared error envelope

All tools return errors in this shape (as MCP tool content, not MCP protocol errors):

```json
{
  "ok": false,
  "error": "state_not_found | invoke_failed | parse_error | unknown",
  "message": "Human-readable one-liner",
  "hint": "Optional recovery suggestion"
}
```

### `polaris_status` / `polaris_loop_status` success response

```json
{
  "ok": true,
  "run_id": "pol-cluster-2-20260525",
  "cluster_id": "POL-3",
  "status": "running",
  "active_child": "POL-14",
  "completed_children": ["POL-9", "POL-10", "POL-11", "POL-12", "POL-13"],
  "open_children": ["POL-14", "POL-15"],
  "context_budget": {
    "children_completed": 2,
    "max_children_per_session": 3,
    "remaining": 1
  },
  "step_cursor": "03-execute-child",
  "schema_version": "1.0"
}
```

Note: `remaining` is computed as `max(0, max_children_per_session - children_completed)` — never negative (see §9, budget bug).

### `polaris_current_state` success response

```json
{
  "ok": true,
  "artifact_dir": "polaris-run",
  "state": { /* raw current-state.json contents, redacted */ }
}
```

---

## 5. Safety Boundary Recommendations

### Hard boundaries (never bypass)

| Forbidden | Rationale |
|---|---|
| `execSync(userInput)` / `eval()` | Arbitrary shell execution via injection |
| Shell string interpolation for subprocess args | Use array form: `spawn('node', ['dist/cli.js', 'status', '--json'])` |
| Reading files outside repo root | Path traversal risk |
| Exposing secrets/tokens in output | Defensive redaction rule in `polaris_current_state` |
| Dynamic tool registration at runtime | Tool surface must be static and auditable |

### Tool surface enforcement

The tool registry (`src/mcp/tools/index.ts`) is the single source of truth. Any call to an unregistered tool name returns an error — no fallthrough, no dynamic dispatch.

### Subprocess invocation pattern

```typescript
// src/mcp/lib/invoke.ts
import { spawnSync } from "node:child_process";

export function invokePolarisJson(args: string[]): unknown {
  // Array form — no shell string interpretation
  const result = spawnSync("node", ["dist/cli.js", ...args], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 10_000,
    shell: false   // <-- critical: never true
  });
  if (result.error || result.status !== 0) throw new InvokeError(result.stderr);
  return JSON.parse(result.stdout);
}
```

### Mutating tool gate (for later tools)

When mutating tools are added, they must include a required `confirmation_token` parameter. The server generates a fresh token per session and requires it to be echoed back. This is a lightweight anti-footgun gate, not a full auth system. Full approval-envelope design belongs in a separate issue.

---

## 6. Local Installation and Configuration Plan

### Prerequisites

- Polaris repo cloned locally
- Node.js 20+ installed
- `npm link` run from repo root (makes `polaris` available in PATH) — or use the relative path invocation (see §8)

### Step 1: Add MCP SDK dependency

```bash
npm install @modelcontextprotocol/sdk
```

### Step 2: Build the MCP server

```bash
npm run build
# produces dist/mcp/server.js
```

### Step 3: Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

`POLARIS_ROOT` env var is the canonical way the server locates the repo root (see §6 on repo-root resolution below).

### Step 4: Restart Claude Desktop

Claude Desktop reads config on startup. Restart required after editing.

### Repo root resolution strategy

Priority order (in `src/mcp/lib/root.ts`):

1. `process.env.POLARIS_ROOT` — explicit override, cleanest for multi-repo setups
2. Walk up from `process.cwd()` looking for `package.json` with `"name": "polaris"` — works when launched from inside the repo
3. Walk up from `import.meta.url` of the compiled server — works when `node dist/mcp/server.js` is invoked from anywhere

This avoids `git rev-parse` subprocess for the root lookup (keeps startup fast).

### State file resolution

Given `repoRoot` and optional `artifact_dir` (default `polaris-run`):

```
{repoRoot}/.taskchain_artifacts/{artifact_dir}/current-state.json
```

This mirrors how the bootstrap-run skill locates its state today.

---

## 7. Smoke Test Plan

### Manual smoke test (before Claude Desktop wiring)

```bash
# 1. Build
npm run build

# 2. Run server in stdio test mode
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dist/mcp/server.js

# Expected: JSON listing polaris_status, polaris_loop_status, polaris_current_state

# 3. Call polaris_status
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"polaris_status","arguments":{}}}' \
  | node dist/mcp/server.js

# Expected: JSON with ok:true and runtime state, OR ok:false with state_not_found if no run exists yet
```

### Claude Desktop integration smoke test

1. Restart Claude Desktop after config update
2. In Claude Desktop: "What tools do you have from Polaris?"
3. Expected: Claude lists `polaris_status`, `polaris_loop_status`, `polaris_current_state`
4. In Claude Desktop: "Check polaris status"
5. Expected: Claude calls `polaris_status` and returns structured state

### Automated test (for CI)

- Unit test: `invoke.ts` with a fake subprocess that returns known JSON — verifies parsing, error handling, timeout behavior
- Integration test: spin up the MCP server process, send tool/list and a tool/call over stdio, assert on response shape

---

## 8. Decision: CLI Invocation vs Direct Module Import

**Decision: CLI subprocess invocation, with direct file read as a targeted fallback for `polaris_current_state`.**

### Rationale

| Factor | CLI subprocess | Direct module import |
|---|---|---|
| Decoupling from internals | Strong — stable CLI contract | Weak — couples to internal API shape |
| Installation requirement | Binary must be built/linked | None — can run from source |
| Startup overhead | ~200ms per call (Node.js startup) | Negligible |
| Error surface | stdout/stderr/exit code | TypeScript exceptions, type drift |
| Testability | Mock subprocess in tests | Import mock |
| MCP server stays thin | Yes — just a bridge | No — embeds Polaris logic |

The issue explicitly states "MCP should be a thin bridge to Polaris runtime." CLI subprocess invocation upholds this. The MCP server should not own any Polaris business logic.

**Subprocess invocation target:** `node dist/cli.js status --json` (relative to repo root) — this avoids the `npm link` requirement for the MCP server itself, since `dist/` is always present after `npm run build`.

**Exception — `polaris_current_state`:** Direct file read is acceptable here because this tool's sole purpose is to return the file contents. Running a subprocess to read a JSON file would be wasteful and brittle.

---

## 9. Follow-Up Implementation Issue Breakdown

### POL-77: Implement polaris MCP server (read-only first slice)

Scope:
- Add `@modelcontextprotocol/sdk` to `package.json`
- Create `src/mcp/server.ts`, `tools/`, `lib/`
- Implement `polaris_status`, `polaris_loop_status`, `polaris_current_state`
- Add `dist/mcp/server.js` as build output
- Write unit tests for `invoke.ts` and tool handlers
- Write smoke test script

Depends on: POL-3 (Cluster 2) merged — needs `dist/cli.js status --json` to exist. Can be developed against a stub/mock if POL-3 is still open.

### POL-78: Claude Desktop setup documentation

Scope:
- `docs/integrations/claude-desktop-mcp.md`
- Step-by-step: build, config, restart, smoke test
- Troubleshooting: config file location on macOS/Windows/Linux, common errors

Depends on: POL-77 implemented.

### POL-79: Fix budget display: clamp remaining to 0 (budget counter normalization)

Scope:
- The display `Context budget: 5/3 children completed (-2 remaining)` shows negative remaining
- Root cause: `remaining = max - completed` without `Math.max(0, ...)` clamp
- Fix: clamp in the status formatter and in the MCP status tool output schema
- File location: wherever `polaris status` formats budget output (in Cluster 2/POL-3 work)

Priority: Low — cosmetic, not a blocker for MCP proof.

### Future (Cluster 4+): `polaris_loop_continue_dry_run`

Blocked on:
- `ContinueOptions` gaining a `dryRun: boolean` field
- `polaris loop continue --dry-run` being wired to actual dry-run semantics (not just flag parsing)

Do not implement the MCP tool for this until the underlying CLI flag is truly functional.

### Future: `polaris_run`, `polaris_loop_continue`, `polaris_finalize`

These require a separate approval-boundary design (confirmation tokens, policy-based gates). Recommend a dedicated analysis issue before implementation.

---

## 10. Recommendation for When to Add Mutating Tools

**Rule: no mutating tool enters the MCP surface without a corresponding approval boundary design.**

| Tool | Gate required before MCP exposure |
|---|---|
| `polaris_loop_continue_dry_run` | `--dry-run` fully wired in CLI (not just parsed) |
| `polaris_loop_continue` | Explicit per-call confirmation token OR approved taskchain policy file in repo |
| `polaris_run` | Same as `loop_continue` + separate approval design issue |
| `polaris_finalize` | Explicit per-call confirmation + PR/push scope explicitly acknowledged |

**Recommended approval envelope for first mutating tool (when ready):**

Require a `confirm` parameter that must equal a server-generated session token. The session token is returned by a new `polaris_session_info` tool (read-only) and is rotated on server restart. This prevents accidental mutation from stale tool calls while keeping the UX lightweight for intentional use.

**The Alice/Delegator model alignment:**
- User grants Alice (Claude Desktop) authority over specific Polaris operations
- Each authority grant maps to a set of unlocked MCP tools
- Authority is stored in a policy file in the repo (not in the MCP server itself)
- The MCP server reads the policy file to determine which tools are active

This policy-file approach keeps the MCP server stateless and makes authority grants auditable via git history. Design this in a separate issue when the first mutating tool is ready to ship.

---

## Budget Display Bug: Separate Issue Recommendation

**Recommendation: file as POL-79, low priority, fix in Cluster 2 (POL-3) scope.**

The bug `Context budget: 5/3 children completed (-2 remaining)` will surface when:
- `children_completed` exceeds `max_children_per_session` (due to resumed session not resetting the counter)
- The display formula is `remaining = max - completed` without a clamp

Fix is a one-liner: `remaining = Math.max(0, max_children_per_session - children_completed)`.

The MCP status tool output schema already specifies `remaining` as non-negative (see §4). The CLI formatter and any future status display should follow the same rule.

This is not a blocker for the MCP proof.

---

## Questions Answered

| # | Question | Answer |
|---|---|---|
| 1 | Minimum MCP server shape | Node.js/TS stdio process, `@modelcontextprotocol/sdk`, 3 read-only tools |
| 2 | Where in repo | `src/mcp/` |
| 3 | Node/TS? | Yes — consistent with Polaris stack |
| 4 | Binary vs module import | CLI subprocess for status tools; direct file read for `polaris_current_state` |
| 5 | Locate repo root | `POLARIS_ROOT` env var → walk up from `cwd` → walk up from `import.meta.url` |
| 6 | Locate current-state.json | `{repoRoot}/.taskchain_artifacts/polaris-run/current-state.json` |
| 7 | Claude Desktop config | `claude_desktop_config.json` mcpServers entry, `node dist/mcp/server.js` |
| 8 | Install steps | `npm install`, `npm run build`, edit Claude Desktop config, restart |
| 9 | `polaris_status` output schema | See §4 — compact JSON with `ok`, state fields, budget with non-negative remaining |
| 10 | Error return | Tool-level `{"ok":false,"error":"code","message":"...","hint":"..."}` |
| 11 | Avoid arbitrary shell execution | Static tool registry, array-form subprocess, `shell: false`, no user input passthrough |
| 12 | Gate mutating tools | Confirmation token (session-scoped) + policy file in repo; see §10 |
| 13 | Smallest smoke test | stdio echo test via terminal; see §7 |
| 14 | Coexist with `.claude/skills/` | Separate paths, no conflict — skills for Claude Code, MCP for Claude Desktop |
| 15 | Follow-up issues | POL-77 (implement), POL-78 (docs), POL-79 (budget bug), future mutating tool design |

---

## Success Criteria Checklist

- [x] Claude Desktop connecting to local Polaris through MCP — **path is clear (§6)**
- [x] First read-only `polaris_status` tool — **designed (§3, §4)**
- [x] No arbitrary shell exposure — **enforced by static registry + `shell: false` subprocess (§5)**
- [x] No autonomous mutation in first slice — **mutating tools not registered (§3)**
- [x] Compact structured status output — **schema defined (§4)**
- [x] Install/setup instructions — **step-by-step plan (§6)**
- [x] Future path to mutating tools — **gated design described (§10)**
- [x] Coexistence with Claude Code skill plugin surface — **confirmed (§2, Q14)**
