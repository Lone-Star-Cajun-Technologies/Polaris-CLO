<!-- BEGIN POLARIS GENERATED -->
<!-- polaris:template-version: 1 -->
# Summary: skill-packet

## Purpose
Generates the bootstrap packet that hand-loads a Polaris skill session with its role, authority boundaries, and (for `reconcile`) a concrete work inventory.

## Core Concepts
- `SKILL_ROLE_MAP` maps each `SkillName` (`analyze`, `run`, `ingest`, `promote`, `triage`, `review`, `catalog`, `reconcile`) to an `AgentRole` (`Analyst`, `Foreman`, `Librarian`, `Worker`).
- Every packet carries `authority_boundaries` and `prohibited_actions` — the enforceable scope contract for that role.
- `ReconcilePacket` is the only packet kind that derives real repository state: `affected_folders` and `work_inventory` come from git diff cross-referenced against `.polaris/map/file-routes.json`.
- `CheckpointGate` (`self_approval_prohibited: true`) is embedded in setup-bootstrap packets so the Foreman cannot self-approve gated checkpoints.

## Architectural Role
Sits between the CLI (`src/cli`) and skill chain execution (`.polaris/skills/`): produces the JSON packet a skill session loads on entry, but does not itself execute skill logic.

## Key Constraints
- `ReconcilePacket.allowed_write_paths` is restricted to `POLARIS.md`/`SUMMARY.md` under affected folders only.
- No fabricated `affected_folders`/`work_inventory` — falls back to an empty/blocked state when git diff is unavailable.

## Important Relationships
- **Upstream**: `src/map` (file-routes.json for affected-folder resolution), `src/config` (skill_packet config defaults)
- **Downstream**: `src/cli` (registers `polaris skill packet <skill-name>`), `.polaris/skills/` (chain execution consumes the generated packet)

## Current State
`ReconcilePacket` now returns real `run_id`, `issue_id`, `affected_folders`, `work_inventory`, `allowed_write_paths`, `prohibited_write_paths`, and `constraints` derived from git diff — previously this was a stub.

## Route Health

### Healthy
Generator and CLI have test coverage (`generator.test.ts`, `cli.test.ts`) for both static packet builders and the git-diff-derived reconcile packet.

## Canonical References

```yaml
canonical_docs:
  - POLARIS.md
  - smartdocs/specs/active/closeout-librarian-spec.md
```

<!-- END POLARIS GENERATED -->