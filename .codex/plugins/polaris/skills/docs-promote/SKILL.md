---
name: docs-promote
description: Review and promote candidate SmartDocs through the Polaris governance skill packet
---
<!-- polaris-codex-skill-version: 1 -->

# docs-promote

Review and promote candidate SmartDocs through the Polaris governance skill packet

This Codex plugin skill is a thin wrapper around the canonical Polaris skill. It does not implement a parallel runtime.

## Usage

```text
docs-promote
```

## Arguments

None.

## Mandatory Routing

1. Read `.polaris/skills/ROUTING.md` and resolve `docs-promote` to its target skill.
2. Read `.polaris/skills/docs-promote/SKILL.md` before any repo inspection, tracker lookup, or runtime file reads.
3. Run the skill bootloader from that canonical `SKILL.md`:
   ```bash
   polaris skill packet promote
   ```
4. If no packet is returned, stop and report: `Blocking: Polaris could not authorize this run.`
5. Execute `.polaris/skills/docs-promote/chain.md` in strict step order.

If `.polaris/skills/docs-promote/SKILL.md` is missing, stop and report:
`Blocking: skill packet not found at .polaris/skills/docs-promote/SKILL.md`
