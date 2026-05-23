# Polaris (repo root)

## Purpose

Polaris is a standalone taskchain orchestration and runtime framework for AI-assisted repository governance. It provides a loop/map/finalize architecture for running governed cluster sessions, tracking file route ownership, and delivering clean feature branches via automated finalization.

## What belongs here

- `polaris.config.json` — project-level Polaris configuration
- `POLARIS.md` — this file; repo-level instruction coverage
- Top-level config files: `tsconfig.json`, `package.json`, `.polarisignore`, `.eslintrc*`
- CI/CD config (`.github/`)
- Root-level docs and READMEs

## What does not belong here

- Source implementation — all TypeScript belongs in `src/`
- Runtime state — all live state belongs in `.polaris/`
- Artifact storage — all session artifacts belong in `.taskchain_artifacts/`
- Cluster execution skills — all `.codex/` skills belong in `.codex/`

## Editing rules

- Never commit cluster work directly to `main`. Create a branch per Linear issue: `philmeaux/<pol-id>-<slug>`.
- PR targets `main` with `--base main` explicitly set.
- Do not add speculative config fields to `polaris.config.json` — only what the current implementation reads.
- Match existing TypeScript style (Node16 module system, ES2022 target).

## Architecture assumptions

- All Polaris source lives in this repo (`ItIsYeBananaduck/Polaris`).
- The repo is NOT an EVO app. Do not apply EVO app doctrine here.
- `src/` holds implementation; `docs/` holds specs and planning docs; `.polaris/` holds runtime state.
- The loop/map/finalize triad is the core execution model — see `docs/spec/polaris-architecture-spec.md`.

## Read before editing

- `docs/spec/polaris-architecture-spec.md` — loop/map/finalize architecture
- `docs/spec/polaris-implementation-plan.md` — failure modes, recommendation, implementation tree
- `CLAUDE.md` — project-specific agent instructions (branch convention, stack, commands)
- `.codex/skills/polaris-run/chain.md` — implementation cluster execution chain

## Related routes

- `polaris.root` — repo root files
- `polaris.config` — configuration subsystem (`src/config/`)
