# Provider Capability Matrix

> Written as part of POL-55 analysis convergence. This document does not require another analyze pass — it directly informs POL-71 (Claude Code skill), POL-72 (Codex plugin), and POL-73 (Windsurf path).

## Decision summary

| Provider | Role | Primary path | Plugin needed |
|---|---|---|---|
| Claude Code | Worker + orchestrator | agent-subtask adapter; native Bash | Yes → POL-71 |
| Codex | Worker | terminal-cli adapter via plugin | Yes → POL-72 |
| Windsurf | Orchestrator only | command invocation; no native subagents | Script → POL-73 |
| Terminal CLI | Worker | direct `polaris run <id>` | No |
| CI worker | Worker | direct `polaris run <id>` in job step | No |
| Gemini/Antigravity | Deferred | terminal-cli if CLI stabilizes | Deferred |
| Connect/Alice | Deferred | future runtime; defer to Cluster 6 | Deferred |

## Full capability matrix

| Capability | Claude Code | Codex | Windsurf | Terminal CLI | CI worker | Gemini | Connect |
|---|---|---|---|---|---|---|---|
| Install plugin/skill package | ✓ `.codex/skills/` | ✓ plugin manifest | Limited | N/A | N/A | Unknown | Deferred |
| Plugin exposes Polaris tools | ✓ | ✓ | Limited | N/A | N/A | Unknown | Deferred |
| Call local Polaris CLI | ✓ Bash access | ✓ shell exec or MCP | ✓ command runner | ✓ direct | ✓ direct | Likely | Deferred |
| Native subagent spawning | ✓ agent-subtask | Unknown | **✗ confirmed** | N/A | N/A | Unknown | Deferred |
| Terminal CLI worker mode | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Deferred |
| Bootstrap packet from file/env | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Deferred |
| Compact JSON return to stdout | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Deferred |
| Commit / update durable state | ✓ | ✓ | ✓ via delegated provider | ✓ | ✓ | ✓ | Deferred |
| Orchestrator-only mode | ✓ | ✓ | **✓ primary role** | N/A | N/A | N/A | Deferred |
| Manual setup required | `npm link` | `npm link` + plugin install | `npm link` + command config | `npm link` | CI env setup | TBD | Deferred |

## Adapter mapping

```
Provider              Adapter
─────────────────     ───────────────────────────
Claude Code           agent-subtask (native)
                      terminal-cli (fallback)
Codex                 terminal-cli via plugin
Windsurf              n/a — orchestrator calls CLI directly
Terminal CLI          terminal-cli (direct)
CI worker             terminal-cli (direct)
```

## Windsurf clarification

Windsurf is an orchestrator/delegator **only**. It:
- Runs `polaris loop continue --provider <provider>` via command runner
- Does NOT spawn native subagents
- Does NOT implement child work
- Delegates all worker execution to the configured provider

Do not assume Windsurf can act as a worker.

## Deferred providers

**Gemini/Antigravity**: Gemini CLI integration path is unknown; plugin surface not yet stable. Defer until Gemini CLI documentation confirms local command invocation semantics. Use terminal-cli adapter as fallback when available. No implementation issue created.

**Connect/Alice**: Future anchor runtime. Defer to Cluster 6. No implementation issue created.

**OpenCode/generic agents**: Any agent that can run shell commands can use the terminal-cli adapter with no plugin. No dedicated implementation issue needed — covered by POL-67 (CLI surface).

## Guardrail note

The analyze-drift guardrail (POL-74) applies across all provider paths. The parent loop runtime enforces it regardless of which adapter is in use.
