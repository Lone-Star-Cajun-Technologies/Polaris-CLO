---
name: polaris-run
description: Execute a Polaris run cluster via the Foreman skill packet
---
<!-- polaris-codex-skill-version: 1 -->

# polaris-run

Execute a Polaris run cluster via the Foreman skill packet

This Codex plugin skill is a thin wrapper around the canonical Polaris skill. It does not implement a parallel runtime.

## Usage

```text
polaris-run <cluster_id>
```

## Arguments

- `cluster_id` (required) - Cluster ID to execute (e.g., POL-257)

## Mandatory Routing

1. Read `.polaris/skills/ROUTING.md` and resolve `polaris-run` to its target skill.
2. Read `.polaris/skills/polaris-run/SKILL.md` before any repo inspection, tracker lookup, or runtime file reads.
3. Run the skill bootloader from that canonical `SKILL.md`:
   ```bash
   polaris skill packet run <cluster_id>
   ```
4. If no packet is returned, stop and report: `Blocking: Polaris could not authorize this run.`
5. Execute `.polaris/skills/polaris-run/chain.md` in strict step order.

If `.polaris/skills/polaris-run/SKILL.md` is missing, stop and report:
`Blocking: skill packet not found at .polaris/skills/polaris-run/SKILL.md`
