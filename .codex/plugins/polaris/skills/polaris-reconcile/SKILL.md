---
name: polaris-reconcile
description: Reconcile project cognition via the triage skill packet
---
<!-- polaris-codex-skill-version: 1 -->

# polaris-reconcile

Reconcile project cognition via the triage skill packet

This Codex plugin skill is a thin wrapper around the canonical Polaris skill. It does not implement a parallel runtime.

## Usage

```text
polaris-reconcile <target>
```

## Arguments

- `target` (required) - Reconciliation target (e.g., smartdocs or a cluster ID)

## Mandatory Routing

1. Read `.polaris/skills/ROUTING.md` and resolve `polaris-reconcile` to its target skill.
2. Read the resolved target skill's `SKILL.md` (`.polaris/skills/polaris-reconcile/SKILL.md`) before any repo inspection, tracker lookup, or runtime file reads.
3. Run the skill bootloader from that canonical `SKILL.md`:
   ```bash
   polaris skill packet reconcile <target>
   ```
4. If no packet is returned, stop and report: `Blocking: Polaris could not authorize this run.`
5. Execute the resolved target skill's `chain.md` (`.polaris/skills/polaris-reconcile/chain.md`) in strict step order.

If the resolved target skill's `SKILL.md` (`.polaris/skills/polaris-reconcile/SKILL.md`) is missing, stop and report:
`Blocking: skill packet not found at .polaris/skills/polaris-reconcile/SKILL.md`
