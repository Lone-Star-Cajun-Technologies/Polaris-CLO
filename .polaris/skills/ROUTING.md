# Polaris Skill Command Hard-Routing

This document defines the mandatory routing protocol for explicit Polaris skill commands.

It is **provider-neutral** and applies to all agents: Claude, Codex, Copilot, Gemini, and
future agents. Any agent instruction surface that references `.polaris/` inherits this rule.

---

## When this rule applies

This rule applies whenever a user message is an explicit Polaris skill command — that is, any
message whose primary instruction is to invoke a named Polaris skill.

### Notation key

| Notation | Meaning |
|---|---|
| `<POL-###>` | Required placeholder — substitute the actual issue ID (e.g., `POL-257`) |
| `[issue]` | Optional literal word — the word "issue" may be present or absent |

### Recognized command patterns

| User command | Target skill | Skill packet path |
|---|---|---|
| `polaris-analyze <POL-###>` | polaris-analyze | `.polaris/skills/polaris-analyze/` |
| `run polaris-analyze on [issue] <POL-###>` | polaris-analyze | `.polaris/skills/polaris-analyze/` |
| `polaris-run <POL-###>` | polaris-run | `.polaris/skills/polaris-run/` |
| `run polaris-run on [issue] <POL-###>` | polaris-run | `.polaris/skills/polaris-run/` |
| `polaris-finalize` | polaris-run | `.polaris/skills/polaris-run/` |
| `run polaris-finalize` | polaris-run | `.polaris/skills/polaris-run/` |
| `polaris-status` | polaris-tools | `.polaris/skills/polaris-tools/` |
| `run polaris-status` | polaris-tools | `.polaris/skills/polaris-tools/` |
| `docs-ingest` | docs-ingest | `.polaris/skills/docs-ingest/` |
| `run docs-ingest` | docs-ingest | `.polaris/skills/docs-ingest/` |
| `docs-promote` | docs-promote | `.polaris/skills/docs-promote/` |
| `run docs-promote` | docs-promote | `.polaris/skills/docs-promote/` |

> **Note:** `closeout-librarian` is NOT a user-facing command. It is dispatched by the
> Foreman as a bounded session during step 08 of the `polaris-run` chain. Users do not
> invoke it directly. The Foreman generates its packet via `npm run polaris -- librarian packet <cluster-id>`.

---

## Required routing protocol

When a recognized command is detected, execute these steps **in order**:

1. **Resolve the target skill and load its packet first.**
   Look up the command in the routing table above to find the **target skill** (the target skill
   may differ from the command name — e.g., `polaris-finalize` → `polaris-run`). Read
   `.polaris/skills/<target-skill>/SKILL.md`. Do not investigate the repo, summarize the issue,
   browse runtime files, or invent a process before reading the skill packet. The skill packet is
   the authoritative instruction source.

2. **Run the skill bootloader.**
   Execute the bootloader command specified in the SKILL.md (typically
   `npm run polaris -- skill packet <name>`). Do not begin work until a packet is returned.

3. **Execute the chain.**
   Follow `chain.md` in strict step order. Do not skip steps, reorder steps, or substitute
   general investigation for a defined step.

4. **Bind the named issue.**
   If the command specifies an issue ID (e.g., `POL-257`), bind exactly that issue.
   Do not substitute another issue or infer a different target.

5. **One issue per invocation (when an issue is bound).**
   When an issue ID is present, process one issue per skill invocation. Only process multiple
   issues in a single invocation if the skill's `chain.md` explicitly states it supports batching.
   Commands that carry no issue ID (e.g., `polaris-finalize`) are not subject to this constraint.

---

## Blocking conditions

If any of the following conditions occur, **stop immediately** and report the blocking condition.
Do not continue, substitute, or attempt workarounds.

| Condition | Required response |
|---|---|
| `SKILL.md` not found at `.polaris/skills/<target-skill>/SKILL.md` | `Blocking: skill packet not found at .polaris/skills/<target-skill>/SKILL.md` |
| Runtime packet not returned by the bootloader command | `Blocking: Polaris could not authorize this run.` |
| Named issue does not match the skill's allowed parent type | Report the mismatch as described in the skill's SKILL.md |

---

## What this rule prohibits before reading the skill's SKILL.md

The following actions are prohibited until the target skill's `SKILL.md` has been read and the
bootloader command has returned a runtime packet. The bootloader itself (`npm run polaris -- skill
packet <name>`, as specified in SKILL.md) is the only Polaris CLI call that is authorized before
the runtime packet is returned.

- Ad hoc repo inspection (reading source files, grep, find)
- Summarizing the named issue from a tracker
- Inventing a process or substituting general investigation
- Reading runtime state files (`.taskchain_artifacts/`, `.polaris/runs/`, `.polaris/clusters/`)
- Calling any Polaris CLI command other than the skill bootloader (e.g., `polaris loop continue`,
  `polaris loop dispatch`, `polaris finalize`)

Once the runtime packet is returned, the skill packet's chain defines what the agent may do and
in what order. Nothing outside that chain is authorized.
