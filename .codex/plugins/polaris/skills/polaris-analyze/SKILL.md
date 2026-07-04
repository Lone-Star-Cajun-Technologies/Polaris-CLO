---
name: polaris-analyze
description: Analyze a cluster and produce an implementation plan via the Analyst skill packet
---
<!-- polaris-codex-skill-version: 1 -->

# polaris-analyze

Analyze a cluster and produce an implementation plan via the Analyst skill packet

This Codex plugin skill is a thin wrapper around the canonical Polaris skill. It does not implement a parallel runtime.

## Usage

```text
polaris-analyze <cluster_id>
```

## Arguments

- `cluster_id` (required) - Cluster ID to analyze (e.g., POL-257)

## Mandatory Routing

1. Read `.polaris/skills/ROUTING.md` and resolve `polaris-analyze` to its target skill.
2. Read `.polaris/skills/polaris-analyze/SKILL.md` before any repo inspection, tracker lookup, or runtime file reads.
3. Run the skill bootloader from that canonical `SKILL.md`:
   ```bash
   polaris skill packet analyze <cluster_id>
   ```
4. If no packet is returned, stop and report: `Blocking: Polaris could not authorize this run.`
5. Execute `.polaris/skills/polaris-analyze/chain.md` in strict step order.

If `.polaris/skills/polaris-analyze/SKILL.md` is missing, stop and report:
`Blocking: skill packet not found at .polaris/skills/polaris-analyze/SKILL.md`
