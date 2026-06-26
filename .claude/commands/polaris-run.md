<!-- polaris-shim-version: 1 -->
# /polaris-run

Execute a Polaris run cluster via the Foreman skill packet

## Usage

```
/polaris-run <cluster_id>
```

## Arguments

- `cluster_id` (required) — Cluster ID to execute (e.g., POL-257)

## Routing

This slash command is a shim around the **run** Polaris skill packet.
It does not implement a parallel runtime — it routes through the existing packet+chain path.

See `.polaris/skills/ROUTING.md` for the full routing protocol and skill directory resolution.

## Execution

1. Look up `/polaris-run` in `.polaris/skills/ROUTING.md` to find the target skill directory.
2. Read `.polaris/skills/<target-skill>/SKILL.md` — it is the authoritative instruction source.
3. Run the skill bootloader:
   ```
   polaris skill packet run
   ```
   Do not begin work until a packet is returned.
   If no packet is produced, stop and report: **Polaris could not authorize this run.**
4. Execute the chain as instructed in the packet.
