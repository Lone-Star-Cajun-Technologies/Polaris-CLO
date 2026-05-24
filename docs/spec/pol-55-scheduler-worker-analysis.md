> POL-55 Analysis — Scheduler-only parent loop and provider worker adapters
> Status: Analysis complete. Do not implement until issues are triaged.

# POL-55: Scheduler-Worker Architecture Analysis

## 1. Plugin Feasibility — Claude and Codex

### Claude Code

Claude Code already supports skills via the `.codex/skills/` directory. The `bootstrap-run` skill proves this works today. A `polaris-loop` skill can replace it.

Skills in Claude Code are instructional markdown documents, not compiled code. A skill exposes a `chain.md` (step protocol), a `README.md` (description), and any supporting reference docs. Claude reads them and follows the protocol.

For tool registration beyond instructional chains, Claude Code supports MCP servers. Polaris could optionally expose a local MCP server (`polaris mcp serve`) that provides structured tools (`polaris_loop_continue`, `polaris_map_query`, etc.), but this is not required for the initial integration. The Bash tool plus a skill chain is sufficient.

Claude Code can also spawn isolated worker subagents natively via the `agent-subtask` adapter. This was verified in the POL-42 live run. The parent dispatches a child session; the child executes one task, commits, and exits. The parent receives only what the child produces as output.

**Verdict:** Claude Code is the highest-confidence plugin target. Skill chain is the correct distribution mechanism for instructional behavior. MCP is the correct distribution mechanism for structured tools. `agent-subtask` is the correct worker dispatch path.

### Codex

Codex uses the same `.codex/skills/` directory structure. The `AGENTS.md` at repo root is Codex's primary instruction document. Codex CLI can run shell commands, making `polaris loop continue` callable directly.

Codex supports hooks in `.codex/` that fire around task execution. A Polaris plugin for Codex would be:
- A `README.md` and `chain.md` in `.codex/skills/polaris-loop/`
- Optionally a `hooks/` directory for pre/post execution state sync
- AGENTS.md additions pointing to the skill

Whether Codex can spawn isolated subagents natively is **unconfirmed**. Until verified, assume Codex workers use the `terminal-cli` adapter: `polaris loop worker --child <id> --bootstrap <path>`.

**Verdict:** Codex skill distribution is feasible via `.codex/skills/`. CLI invocation path is clear. Native subagent spawning needs verification against current Codex documentation before implementing a `codex-subagent` adapter.

---

## 2. Plugin-to-Local-CLI Invocation

Both Claude Code and Codex can invoke a local `polaris` binary via shell commands. The plugin/skill layer does not need to understand Polaris internals. It only needs to:

1. Construct the correct `polaris` command (`polaris loop continue`, `polaris loop worker --child <id>`, etc.)
2. Pass a bootstrap packet path or inline args
3. Capture the compact JSON return summary from stdout

This means the skill chain is just a routing document. All Polaris logic lives inside the `polaris` binary. Polaris owns:
- current-state.json
- telemetry JSONL
- bootstrap packet generation
- adapter dispatch
- compact return format
- continuation/stop decisions

The plugin owns nothing except: "when the user invokes Polaris loop, call this CLI command."

The key requirement this imposes: **Polaris must be installable and locally reachable from the plugin environment.** See Section 3.

---

## 3. Polaris Package/CLI Surface

### Minimum surface for Phase 1

`package.json` must gain:
```json
{
  "bin": { "polaris": "dist/cli/index.js" },
  "scripts": {
    "build": "tsc",
    "test": "...",
    "lint": "..."
  },
  "dependencies": { ... },
  "devDependencies": { "typescript": "^5" }
}
```

Commands required in order of priority:

| Command | Purpose | Phase |
|---|---|---|
| `polaris loop continue` | Resume parent scheduler loop | 1 |
| `polaris loop worker --child <id> --bootstrap <path>` | Execute one child as isolated worker | 1 |
| `polaris loop status` | Show current-state summary | 1 |
| `polaris map index` | Build/update file atlas | 2 |
| `polaris map update --changed` | Incremental map update | 2 |
| `polaris finalize` | Full cluster closeout sequence | 3 |
| `polaris run <issue>` | One-shot run from issue ID | 3 |
| `polaris docs ingest` | Ingest docs into Polaris context | later |
| `polaris mcp serve` | Start local MCP server (optional) | later |

### Installation modes

| Mode | Use case |
|---|---|
| `npm install -D polaris` | Project-local install; plugins find via `./node_modules/.bin/polaris` |
| `npm link` | Dev/test; binary available globally |
| `npx polaris` | Zero-install one-shot; acceptable for CI and ad-hoc use |
| Global install (`npm install -g`) | Not recommended; prefer project-local |

### Plugin binary discovery

Plugins/skills should discover the Polaris binary in this order:
1. `./node_modules/.bin/polaris` (project-local)
2. `polaris` in `$PATH` (global or `npm link`)
3. `npx polaris` (fallback, slower)

---

## 4. Current vs Desired Parent Responsibilities

### What the parent/orchestrator currently does (too much)

Observed in the POL-42 live run:

- Reads step files and child issue bodies in full
- Fetches child Linear issue details including description
- Inspects worker commits, diffs, and validation output
- Runs narrow child-specific validation inline
- Updates Linear child status manually
- Mutates current-state.json fields for child results
- Carries child implementation summaries in chat context
- Dispatches multiple children within the same session before checkpointing

The parent became a token sink because it absorbed child-level work. Even when the implementation was correct, having the parent do it is an architecture bug: it violates the token-boundary design and prevents the scheduler from staying small across many children.

### What the parent should do (scheduler only)

```
1. Parse current-state.json — fail fast on malformed state
2. Select next open child (lowest-numbered, non-blocked)
3. Generate or locate bootstrap packet for child
4. Dispatch child via configured adapter (agent-subtask OR terminal-cli)
5. Receive compact worker return summary (~200 tokens max)
6. Validate required fields in summary
7. Apply budget/stop policy check
8. Write updated checkpoint to current-state.json
9. Repeat from step 2, or stop and report
```

The parent must NOT:
- Read child issue body (bootstrap packet holds what the worker needs)
- Inspect diffs or validation logs
- Run tests or linting
- Update child tracker status (worker owns this)
- Mutate child-level execution state (worker owns this)
- Carry child summaries beyond the compact return object

**The adapter boundary is the token boundary.** Everything a child needs goes into the bootstrap packet. Everything the parent gets back is the compact summary.

---

## 5. Parent Scheduler Contract

```
Input:
  - current-state.json (durable loop state)
  - polaris.config.json (budget policy, adapter config)

Per-iteration:
  1. load_state()           → parse current-state.json; abort on schema error
  2. select_child()         → lowest open child not blocked; CLUSTER_COMPLETE if none
  3. build_bootstrap()      → write bootstrap packet to .polaris/bootstrap/<child_id>.json
  4. dispatch(adapter)      → call adapter with bootstrap packet path
  5. receive_result()       → parse compact return summary from adapter output
  6. validate_result()      → check required fields; mark child failed if invalid
  7. checkpoint(result)     → update current-state.json; commit if configured
  8. budget_check()         → apply stop policy; STOP or CONTINUE

Output on STOP:
  - current-state.json committed
  - resume command printed
  - no child summaries in session context

Output on CLUSTER_COMPLETE:
  - trigger polaris finalize (or print finalize command for human approval)
```

The parent session context grows proportionally to the number of **iterations**, not to the total content of all children. Each iteration adds only: child ID, adapter call, compact summary (~200 tokens), checkpoint write.

---

## 6. Worker Contract

```
Input (bootstrap packet):
{
  "child_id": "POL-XX",
  "cluster_id": "POL-YY",
  "run_id": "...",
  "task_summary": "...",           ← short title/objective only
  "relevant_files": [...],         ← paths worker should read
  "spec_refs": [...],              ← doc paths for context
  "done_criteria": [...],          ← list of acceptance conditions
  "tracker_issue_id": "...",       ← Linear issue ID for status update
  "state_path": ".polaris/runs/.../current-state.json",
  "telemetry_path": ".polaris/runs/.../telemetry.jsonl",
  "adapter": "agent-subtask"       ← how this worker was invoked
}

Worker steps:
  1. Read bootstrap packet
  2. Load only needed context (relevant_files, spec_refs)
  3. Execute child task per done_criteria
  4. Run child-specific validation (tests, lint, build)
  5. Update Polaris map for changed files (polaris map update --changed)
  6. Update tracker child status to Done (Linear or equivalent)
  7. Update current-state.json child completion fields
  8. Append telemetry event to JSONL
  9. Commit all changes: "[<child_id>] <task_summary>"
 10. Write compact return summary to stdout or designated file
 11. Exit — do NOT continue to next child

Output (compact return summary):
{
  "child_id": "POL-XX",
  "status": "done" | "failed" | "blocked",
  "commit": "<hash>",
  "validation": "passed" | "failed" | "skipped",
  "tracker_updated": true | false,
  "state_updated": true | false,
  "telemetry_updated": true | false,
  "next_recommended_action": "continue" | "stop" | "investigate",
  "blocker": null | "description of blocker"
}
```

Workers must NOT:
- Continue to the next child
- Request additional children from the parent
- Spawn additional subworkers (unless explicitly authorized by the task)
- Leave uncommitted changes

---

## 7. Validation Boundary Rules

### Worker owns

- All child-specific implementation validation
- Tests, linting, TypeScript compilation
- Doc consistency checks for changed files
- Polaris map update for changed files
- Linear/tracker child status update
- current-state child completion fields
- Telemetry JSONL append

### Parent owns (minimal)

- Compact return summary parses as valid JSON
- Required fields present (child_id, status, commit, tracker_updated, state_updated)
- current-state.json remains parseable after worker update
- Optional: commit hash exists in git history
- Budget check (children_completed against policy)

### Final closeout (polaris finalize) owns

- Full cluster map validation
- Full schema validation
- Test suite pass
- Run report generation
- Final commit, push, PR creation
- Linear cluster status update to Done
- Run archive
- JSONL close

The parent must NOT run full validation after each child. Doing so bloats the parent session with child-level diagnostic output. If a worker reports `validation: "failed"`, the parent applies the stop policy (typically: stop and report, do not continue).

---

## 8. Configurable Budget/Cap Policy

Current behavior: hardcoded cap of 3 children per parent session.

Proposed `polaris.config.json` schema extension:

```json
{
  "loop": {
    "budget": {
      "mode": "fixed-cap",
      "max_children_per_session": 3,
      "stop_on_child_failure": true,
      "stop_on_dirty_state": true,
      "stop_before_analyze_boundary": true,
      "stop_before_final_closeout": false,
      "require_approval_at_analyze_boundary": true
    }
  }
}
```

### Budget modes

| Mode | Behavior |
|---|---|
| `fixed-cap` | Stop after N children per session (current behavior, default N=3) |
| `until-empty` | Run until no open children remain; single session if budget allows |
| `token-budget` | Stop when context usage reaches configured threshold (future; requires provider telemetry) |
| `single` | Dispatch exactly one child then stop (useful for manual step-through) |

### Stop conditions (all modes)

| Condition | Config field | Default |
|---|---|---|
| Child returned `failed` | `stop_on_child_failure` | `true` |
| current-state is dirty/malformed | `stop_on_dirty_state` | `true` |
| Next child is analyze-type and current is implement-type | `stop_before_analyze_boundary` | `true` |
| Next child is `polaris finalize` | `stop_before_final_closeout` | `false` |
| Budget/cap hit | `max_children_per_session` | `3` |

The cap field should be in `polaris.config.json` rather than hardcoded. The bootstrap-run skill's `max_children_per_session: 3` in current-state.json is the temporary bootstrap equivalent; the native Polaris loop reads from config instead.

---

## 9. Provider/Plugin Capability Matrix

| Provider | Plugin Install | Expose Skills/Tools | Local CLI Call | Native Subagent | Terminal Worker | Bootstrap Packet | Compact Return | Commit/State | Orchestrator-Only | Key Limitations |
|---|---|---|---|---|---|---|---|---|---|---|
| **Claude Code** | Yes (`.codex/skills/`) | Yes (skill chain docs + MCP) | Yes (Bash tool) | **Yes** (`agent-subtask`) | Yes | File or env | stdout / file | Yes | Yes | Bash tool needs explicit permission grants |
| **Claude Desktop** | Via MCP only | Via MCP server tools | Via MCP shell tool | No | No | MCP param | MCP return | Via MCP | No | No local file access without MCP; not suitable for workers |
| **Codex** | Yes (`.codex/skills/`) | Yes (skill docs + hooks) | Yes (shell) | **Unconfirmed** | Yes | File / stdin | stdout | Yes | Yes | Subagent spawn unconfirmed; verify before building adapter |
| **Codex CLI** | N/A | Via AGENTS.md | Yes | N/A | **Yes (primary)** | File / stdin / env | stdout | Yes | No | Stateless; needs explicit bootstrap packet path per invocation |
| **Gemini/Antigravity** | Unknown | Via config/prompt | Via shell (if available) | Unknown | Yes (CLI worker) | File / stdin | stdout | Yes | Possible | Plugin API unconfirmed; shell access environment-dependent |
| **OpenCode** | Unknown | Via config | Via shell | Unknown | **Yes (CLI worker)** | File / stdin | stdout | Yes | Possible | Varies by fork; treat as `terminal-cli` adapter until tested |
| **Windsurf** | No native | Limited (command templates) | **Yes (terminal)** | No | Via terminal | File | Terminal capture | Via CLI | **Yes (only)** | Orchestrator/delegator only; no native worker spawn; run `polaris loop continue` as command |
| **Terminal CLI** | N/A | N/A | Yes (native) | N/A | **Yes (native)** | stdin / file / env | stdout | Yes | No | Manual invocation; wrapping in a script is recommended |
| **CI (GitHub Actions)** | Via workflow YAML | Via step definitions | Yes | Via matrix jobs | Yes | env / artifact | step output / artifact | Yes | Yes | Secrets/env setup required; no interactive approval |
| **Connect/Alice** | TBD | TBD | Via API/CLI | TBD | TBD | TBD | TBD | TBD | TBD | Future anchor-runtime; design TBD post-Cluster 4 |

### Adapter assignment per provider

| Provider | Adapter to use |
|---|---|
| Claude Code (orchestrator) | `agent-subtask` for workers |
| Claude Code (worker) | `terminal-cli` if spawned by another agent |
| Codex (orchestrator) | `codex-subagent` if confirmed; else `terminal-cli` |
| Codex CLI | `terminal-cli` |
| Gemini/Antigravity | `terminal-cli` |
| OpenCode | `terminal-cli` |
| Windsurf | runs `polaris loop continue` only; never dispatches its own workers |
| Terminal / CI | `terminal-cli` |

---

## 10. Adapter Contract Refinements

### Core contract (all adapters, unchanged)

- One child per dispatch
- Input: bootstrap packet (path or inline JSON)
- Output: compact JSON summary to stdout or designated file
- No chat-context sharing between workers
- State transfer only through: branch files, current-state.json, telemetry.jsonl
- Worker must NOT continue to next child
- Worker must update durable state before returning
- Parent must NOT absorb worker context beyond compact summary
- Plugin/skill layer invokes Polaris; Polaris owns runtime semantics

### Adapter interface (proposed TypeScript shape)

```typescript
interface PolarisAdapter {
  name: string;                         // e.g. "agent-subtask", "terminal-cli"
  dispatch(packet: BootstrapPacket): Promise<WorkerResult>;
  canSpawnIsolatedContext(): boolean;   // true for agent-subtask; false for terminal-cli
}

interface BootstrapPacket {
  child_id: string;
  cluster_id: string;
  run_id: string;
  task_summary: string;
  relevant_files: string[];
  spec_refs: string[];
  done_criteria: string[];
  tracker_issue_id: string;
  state_path: string;
  telemetry_path: string;
  adapter: string;
}

interface WorkerResult {
  child_id: string;
  status: "done" | "failed" | "blocked";
  commit: string | null;
  validation: "passed" | "failed" | "skipped";
  tracker_updated: boolean;
  state_updated: boolean;
  telemetry_updated: boolean;
  next_recommended_action: "continue" | "stop" | "investigate";
  blocker: string | null;
}
```

### Adapter-specific notes

**agent-subtask** (Claude Code native)
- Parent calls `Agent({ prompt: bootstrapPacketContents })` or equivalent
- Worker runs in isolated context with no parent memory
- Worker writes compact summary to `.polaris/runs/<run_id>/worker-result-<child_id>.json`
- Parent reads that file as the return value

**terminal-cli**
- Parent calls `polaris loop worker --child <id> --bootstrap <path>`
- Worker reads packet from file, executes, writes compact summary to stdout
- Parent captures stdout and parses as JSON
- Works for Codex CLI, Gemini, OpenCode, Windsurf-delegated runs, CI

**codex-subagent** (future, pending verification)
- Same as `agent-subtask` but uses Codex's subagent API
- Only implement after confirming Codex supports isolated subagent contexts

---

## 11. Implementation Issue Breakdown

These are the follow-up implementation issues that POL-55 analysis produces. Each maps to a discrete implementation child.

| Issue | Title | Depends on | Priority |
|---|---|---|---|
| POL-55-A | Add `bin` + `scripts` to `package.json`; install TypeScript; scaffold `src/cli/index.ts` | None (first) | 1 |
| POL-55-B | Implement `polaris loop continue` — scheduler-only parent (Steps 1–9 of parent contract) | POL-55-A | 2 |
| POL-55-C | Define and implement `BootstrapPacket` + `WorkerResult` TypeScript schemas | POL-55-A | 2 |
| POL-55-D | Implement `PolarisAdapter` interface + `agent-subtask` adapter | POL-55-C | 3 |
| POL-55-E | Implement `terminal-cli` adapter (`polaris loop worker` subcommand) | POL-55-C | 3 |
| POL-55-F | Write `.codex/skills/polaris-loop/` Claude Code skill package (replace bootstrap-run) | POL-55-B | 4 |
| POL-55-G | Write Codex skill/plugin package in `.codex/skills/polaris-codex/` | POL-55-E | 4 |
| POL-55-H | Implement configurable budget policy (`polaris.config.json` `loop.budget`) | POL-55-B | 4 |
| **POL-65** | Write `docs/spec/scheduler-worker-contract.md` (already tracked) | POL-55-B, C | 3 |

### Phases

- **Phase 1 (unblock loop):** POL-55-A → POL-55-B + POL-55-C in parallel
- **Phase 2 (adapters):** POL-55-D + POL-55-E in parallel + POL-65
- **Phase 3 (skills + config):** POL-55-F + POL-55-G + POL-55-H in parallel

---

## 12. Recommendation — Which Provider to Implement First

**Implement Claude Code native path first.**

Rationale:
1. Already proven working in POL-42. `agent-subtask` dispatch is confirmed.
2. Skill infrastructure (`.codex/skills/`) already exists and is used.
3. The `polaris loop continue` CLI maps directly to what the parent needs to do.
4. The parent scheduler loop can be tested immediately with Claude Code and `agent-subtask`.
5. POL-55-F (Claude Code skill) replaces the temporary `bootstrap-run` skill, closing Cluster 1 technical debt.

**Implement Codex CLI (`terminal-cli` adapter) second.**

Rationale:
1. Same `.codex/skills/` infrastructure, minimal new design.
2. `terminal-cli` adapter is the universal fallback for all other providers.
3. Once `terminal-cli` works, Gemini, OpenCode, and Windsurf all get a working path with no additional adapter code.
4. Native Codex subagent dispatch (if it exists) can be added as a thin adapter layer on top later.

**Defer** Claude Desktop, Gemini-native plugin, and Connect/Alice until the core loop and `terminal-cli` adapter are stable. These require either MCP server infrastructure or provider-specific research that should not block the scheduler implementation.

---

## Summary

The core insight of this analysis:

> Polaris should be an installable CLI. Providers install a thin skill/plugin that knows one thing: "call `polaris loop continue`." Polaris owns all runtime logic. Workers are disposable CLI invocations or isolated agent contexts that execute one child and exit. The parent session never touches child implementation detail — it only reads a compact 200-token summary and decides continue-or-stop.

This design makes Polaris provider-neutral: any agent that can run a shell command can be a worker. Any agent that can dispatch a subagent or run a CLI command can be an orchestrator. The plugin layer is minimal by design.

The three blocking implementation tasks before this design can be tested end-to-end are:
1. `package.json` with `bin` entry + TypeScript build
2. `polaris loop continue` as scheduler-only parent
3. `polaris loop worker` as isolated child executor

Everything else — Codex adapters, Gemini paths, Connect/Alice — builds on those three.
