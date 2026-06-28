<!-- polaris-shim-version: 1 -->
# /polaris-analyze

Analyze a cluster and produce an implementation plan via the Analyst skill packet

## Usage

```text
/polaris-analyze <cluster_id>
```

## Arguments

- `cluster_id` (required) — Cluster ID to analyze (e.g., POL-257)

## Routing

This slash command is a shim around the **analyze** Polaris skill packet.
It does not implement a parallel runtime — it routes through the existing packet+chain path.

See `.polaris/skills/ROUTING.md` for the full routing protocol and skill directory resolution.

## Execution

1. Look up `/polaris-analyze` in `.polaris/skills/ROUTING.md` to find the target skill directory.
2. Read `.polaris/skills/<target-skill>/SKILL.md` — it is the authoritative instruction source.
3. Run the skill bootloader:
   ```bash
   polaris skill packet analyze $ARGUMENTS
   ```
   Do not begin work until a packet is returned.
   If no packet is produced, stop and report: **Polaris could not authorize this run.**
4. Execute the chain as instructed in the packet.
