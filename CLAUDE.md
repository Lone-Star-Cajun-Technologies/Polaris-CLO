# Polaris — CLAUDE.md

## Project identity

Polaris is a standalone taskchain orchestration/runtime framework. It is NOT an EVO app. Do not apply EVO app doctrine or EVO app-specific behavior here.

## Stack

- Node.js / TypeScript 5+, targeting ES2022
- Module system: Node16

## Repo structure

```
src/          # implementation (cli/, map/, loop/, finalize/, config/, ignore/)
docs/         # specs and planning docs (spec/, planning/)
.polaris/     # runtime state (map/, bootstrap/, runs/)
.taskchain_artifacts/  # artifact storage for cluster execution sessions
.codex/       # skills for governed cluster execution
```

## Branch convention

**Never commit cluster work directly to `main`.** Each cluster session must work on a dedicated feature branch:

1. At session start, create a branch from `main` named after the Linear issue: `git checkout -b philmeaux/<pol-id>-<slug> main`
2. Commit all work to that branch
3. PR targets `main` (not any other branch)

The branch name comes from the Linear issue's `gitBranchName` field.

## Commands

```
npm test        # run test suite
npm run lint    # lint TypeScript sources
npm run build   # compile to dist/
```

## Bootstrap note

`.codex/skills/bootstrap-run/` is **TEMPORARY — BOOTSTRAP ONLY**. It is replaced by native Polaris taskchains in Cluster 6. Do not treat it as permanent governance infrastructure.

## Implementation target

All Polaris code belongs in this repo (`ItIsYeBananaduck/Polaris`). EVO skill changes (Cluster 7 work) belong in `git-fit`.

## Architecture references

- `docs/spec/polaris-architecture-spec.md` — loop/map/finalize architecture
- `docs/spec/polaris-implementation-plan.md` — failure modes, recommendation, implementation tree
