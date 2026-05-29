# Skill Packet Bootloader Model

## Problem

Agents can bypass Polaris role and skill doctrine by reading a `SKILL.md` file directly and implementing behavior inline. The Foreman seal only works when the agent enters through the Polaris runtime path. Static skill files alone are not enforceable.

## Solution

Skill files become **bootloaders**. A bootloader does not contain the full behavior — it instructs the agent to request a generated skill packet from the Polaris runtime before proceeding.

The generated packet is the authoritative instruction source. The skill file is only an entry gate.

## Bootloader Contract

Every Polaris-managed `SKILL.md` includes a bootloader section at the top:

1. Run `npm run polaris -- skill packet <skill-name>`
2. Do not proceed until a packet is returned.
3. Treat the packet as the authoritative instruction source.
4. If no packet is produced, stop and report that Polaris could not authorize the run.

The rest of the skill folder (`chain.md`, `steps/`) remains in place and continues to be owned by Polaris. It is not embedded into the packet.

## Skill Packet Contents

A generated skill packet contains only:

| Field | Description |
|---|---|
| `packet_id` | Unique UUID for this packet instance |
| `skill_name` | The skill being invoked |
| `active_role` | The agent role for this session |
| `role_summary` | Human-readable description of the role |
| `authority_boundaries` | What the agent is permitted to do |
| `prohibited_actions` | What the agent must not do |
| `allowed_outputs` | Valid output types for this role |
| `deliverables` | Expected end-state of the session |
| `stop_conditions` | Conditions under which the agent must stop |
| `confidence_policy` | Confidence threshold policy (analyze only) |
| `source_config_snapshot` | Config values used when the packet was generated |
| `generated_at` | ISO timestamp |

Chain and step instructions are **not** included in the packet. They remain owned by Polaris via the skill folder.

## Role Mapping

| Skill | Role |
|---|---|
| `analyze` | Analyst |
| `run` | Foreman |
| `ingest` | Librarian |
| `promote` | Librarian |
| worker packet | Worker |

Polaris is the CLO/runtime and is not an agent role.

## CLI Usage

```
npm run polaris -- skill packet analyze
npm run polaris -- skill packet run
npm run polaris -- skill packet ingest
npm run polaris -- skill packet promote
```

Output is JSON. The packet is printed to stdout.

## Policy Notes

### Analyst (analyze)

- May gather evidence, inspect the repo, and create implementation-ready Linear issues.
- May not implement code.
- May not auto-create secondary analysis issues if confidence is below threshold — must ask user first (unless `auto_deep_analysis` is enabled in config).
- Default confidence threshold: 85%.
- Default `auto_deep_analysis`: false.

### Foreman (run)

- Coordinates implementation by dispatching Workers.
- May not implement code directly.
- Must use internal child/subagent fallback by default.
- Cross-provider delegation requires explicit config (`allow_cross_provider_delegation: true`).
- May not mark a child complete without Worker result evidence.

### Librarian (ingest, promote)

- May ingest, classify, route, index, and promote knowledge artifacts.
- May not perform implementation unless given a Worker packet.
- Must preserve provenance and update relevant maps/summaries.
- Promote requires surfacing a conflict report before any `--approve` call.

## Config

Packet policy is controlled by `skill_packet` in `polaris.config.json`:

```json
{
  "skill_packet": {
    "analysis_confidence_threshold": 85,
    "auto_deep_analysis": false,
    "allow_cross_provider_delegation": false
  }
}
```

All fields are optional. Defaults are shown above.

## Authorization Tracking

Each packet includes a `packet_id`. For this first pass, `packet_id` is generated but not yet enforced.

Future behavior:
- Work without a `packet_id` will be treated as manual/unsealed.
- `polaris finalize` may eventually require a valid `packet_id`.
- PR creation may eventually require packet authorization.

## Document Placement Rule

**All documents generated during a Polaris skill session must be placed in `smartdocs/docs/raw/` first.**

No agent may write a document directly to `specs/active/`, `doctrine/active/`, `architecture/`, or `decisions/`. Every document enters through the raw drop zone and is promoted only after classification and explicit approval via `docs-ingest` and `docs-promote`.

## What This Does Not Cover

- Full security or locking enforcement (future work).
- Step-level authorization (future work).
- Cross-provider worker launching (future work — requires explicit config and provider launcher).
- Worker packet replacement — worker packets remain unchanged.
