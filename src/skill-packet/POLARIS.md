<!-- BEGIN POLARIS GENERATED -->
<!-- polaris:template-version: 1 -->
# skill-packet

## Purpose

Generates the bootstrap packets that hand-load a Polaris skill session (`analyze`, `run`, `ingest`, `promote`, `triage`, `review`, `catalog`, `reconcile`) with its authority boundaries, role summary, and — for `reconcile` — the concrete work inventory the session must act on.

**Domain:** skill-packet
**Route:** src/skill-packet
**Taskchain:** polaris-skill-packet

## What belongs here

- `index.ts` — `createSkillCommand()`; wires the safe/read-only `polaris skill packet <skill-name>` CLI subcommand, loads `skill_packet` config (with defaults), and prints the generated packet as JSON
- `generator.ts` — `generateSkillPacket()` builds a `SkillPacket` per skill from `SKILL_ROLE_MAP` (skill → `AgentRole`) and `ROLE_SUMMARIES`; `buildAnalyzePacket()` and sibling builders assemble authority boundaries and prohibited actions per skill. Also builds `ReconcilePacket` for the `reconcile` skill: derives `affected_folders` and `work_inventory` from git diff (uncommitted + branch diff against merge-base with the default branch), cross-referenced against `.polaris/map/file-routes.json` route entries; falls back to an empty/blocked state with no fabricated guesses when no git diff is available
- `types.ts` — `SkillName`, `AgentRole`, `SkillPacket`, `SetupBootstrapMode`, `SetupBootstrapCheckpoint`, `CheckpointGate`, `SetupBootstrapPacket`, `ReconcilePacket`, `ReconcileWorkInventory`
- `cli.test.ts`, `generator.test.ts` — command and generator test coverage

## What does not belong here

- Skill chain execution logic (`.polaris/skills/<name>/chain.md`) — this folder only generates the entry packet, it does not run the skill
- Route/file ownership resolution — delegated to `.polaris/map/file-routes.json` via `src/map`

## Editing rules

- Every skill packet must carry `authority_boundaries` and `prohibited_actions` — the "by construction" guarantee that a role cannot silently exceed scope.
- `ReconcilePacket.allowed_write_paths` is restricted to `POLARIS.md`/`SUMMARY.md` under affected folders; `prohibited_write_paths` covers the repo root. Do not widen this without an explicit spec change.
- `generateSkillPacket()` must never fabricate `affected_folders`/`work_inventory` when git diff is unavailable — return an empty/blocked state instead.
- Keep `index.ts` a thin CLI wrapper; packet construction logic belongs in `generator.ts`.

## Architecture assumptions

- Assumes a git repository with a resolvable default-branch merge-base for reconcile-packet diffing.
- Assumes `.polaris/map/file-routes.json` is current; stale route entries will produce inaccurate `affected_folders`.

## Read before editing

- `smartdocs/specs/active/closeout-librarian-spec.md` — schema consumed by the `reconcile` skill packet
- `src/map/` — file-routes lookup used for affected-folder derivation
- `.polaris/skills/ROUTING.md` — how packets map to skill invocation

## Related routes

- `src/cli/` — registers the `polaris skill` command group
- `src/map/` — route/file ownership source of truth

<!-- END POLARIS GENERATED -->