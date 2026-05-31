# Polaris Skill Command Hard-Routing

This document defines the mandatory routing protocol for explicit Polaris skill commands.

It is **provider-neutral** and applies to all agents: Claude, Codex, Copilot, Gemini, and
future agents. Any agent instruction surface that references `.polaris/` inherits this rule.

---

## When this rule applies

This rule applies whenever a user message is an explicit Polaris skill command — that is, any
message whose primary instruction is to invoke a named Polaris skill.

### Recognized command patterns

| User command | Target skill | Skill packet path |
|---|---|---|
| `polaris-analyze [POL-###]` | polaris-analyze | `.polaris/skills/polaris-analyze/` |
| `run polaris-analyze on [issue] [POL-###]` | polaris-analyze | `.polaris/skills/polaris-analyze/` |
| `polaris-run [POL-###]` | polaris-run | `.polaris/skills/polaris-run/` |
| `run polaris-run on [issue] [POL-###]` | polaris-run | `.polaris/skills/polaris-run/` |
| `polaris-finalize` | polaris-run | `.polaris/skills/polaris-run/` |
| `run polaris-finalize` | polaris-run | `.polaris/skills/polaris-run/` |
| `polaris-status` | polaris-tools | `.polaris/skills/polaris-tools/` |
| `run polaris-status` | polaris-tools | `.polaris/skills/polaris-tools/` |
| `docs-ingest` | docs-ingest | `.polaris/skills/docs-ingest/` |
| `run docs-ingest` | docs-ingest | `.polaris/skills/docs-ingest/` |
| `docs-promote` | docs-promote | `.polaris/skills/docs-promote/` |
| `run docs-promote` | docs-promote | `.polaris/skills/docs-promote/` |

---

## Required routing protocol

When a recognized command is detected, execute these steps **in order**:

1. **Load the skill packet first.**
   Read `.polaris/skills/<skill-name>/SKILL.md`.
   Do not investigate the repo, summarize the issue, browse runtime files, or invent a process
   before loading the skill. The skill packet is the authoritative instruction source.

2. **Run the skill bootloader.**
   Execute the bootloader command specified in the SKILL.md (typically
   `npm run polaris -- skill packet <name>`). Do not begin work until a packet is returned.

3. **Execute the chain.**
   Follow `chain.md` in strict step order. Do not skip steps, reorder steps, or substitute
   general investigation for a defined step.

4. **Bind the named issue.**
   If the command specifies an issue ID (e.g., `POL-257`), bind exactly that issue.
   Do not substitute another issue or infer a different target.

5. **One issue per invocation.**
   Process one issue per skill invocation. Only process multiple issues in a single invocation
   if the skill's `chain.md` explicitly states it supports batching.

---

## Blocking conditions

If any of the following conditions occur, **stop immediately** and report the blocking condition.
Do not continue, substitute, or attempt workarounds.

| Condition | Required response |
|---|---|
| `SKILL.md` not found at `.polaris/skills/<skill-name>/SKILL.md` | `Blocking: skill packet not found at .polaris/skills/<skill-name>/SKILL.md` |
| Runtime packet not returned by the bootloader command | `Blocking: Polaris could not authorize this run.` |
| Named issue does not match the skill's allowed parent type | Report the mismatch as described in the skill's SKILL.md |

---

## What this rule prohibits before the skill packet is loaded

- Ad hoc repo inspection (reading source files, grep, find)
- Summarizing the named issue from a tracker
- Inventing a process or substituting general investigation
- Reading runtime state files (`.taskchain_artifacts/`, `.polaris/runs/`, `.polaris/clusters/`)
- Calling any Polaris CLI commands (`polaris loop continue`, `polaris loop dispatch`, `polaris finalize`)

The skill packet's chain defines what the agent may do and in what order. Nothing outside that
chain is authorized.
