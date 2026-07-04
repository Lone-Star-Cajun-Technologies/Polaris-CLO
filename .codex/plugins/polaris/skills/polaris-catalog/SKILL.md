---
name: polaris-catalog
description: Catalog project cognition and SmartDocs via the catalog skill packet
---
<!-- polaris-codex-skill-version: 1 -->

# polaris-catalog

Catalog project cognition and SmartDocs via the catalog skill packet

This Codex plugin skill is a thin wrapper around the canonical Polaris skill. It does not implement a parallel runtime.

## Usage

```text
polaris-catalog <cluster_id>
```

## Arguments

- `cluster_id` (required) - Cluster ID to catalog (e.g., POL-257)

## Mandatory Routing

1. Read `.polaris/skills/ROUTING.md` and resolve `polaris-catalog` to its target skill.
2. Read `.polaris/skills/polaris-catalog/SKILL.md` before any repo inspection, tracker lookup, or runtime file reads.
3. Run the skill bootloader from that canonical `SKILL.md`:
   ```bash
   polaris skill packet catalog <cluster_id>
   ```
4. If no packet is returned, stop and report: `Blocking: Polaris could not authorize this run.`
5. Execute `.polaris/skills/polaris-catalog/chain.md` in strict step order.

If `.polaris/skills/polaris-catalog/SKILL.md` is missing, stop and report:
`Blocking: skill packet not found at .polaris/skills/polaris-catalog/SKILL.md`
