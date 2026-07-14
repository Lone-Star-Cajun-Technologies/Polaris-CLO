# Summary: cognition

## Purpose
Delta-only signal library for route-local cognition surfaces — determines when `POLARIS.md` or `SUMMARY.md` updates are warranted, validates constraints, and identifies missing surfaces.

## Key behaviors
- Returns signals only; callers own all writes to disk.
- Cognition is scoped per directory, walking upward from touched files; root excluded by default.
- Route health is exposed as a signal helper over atlas entries, using staleness (>90 days), identity completeness (instructionFile and role_owner presence), and cognition presence (POLARIS.md exists) to classify:
  - `stale`: route older than threshold (90 days)
  - `known-issues`: identity incomplete (missing instructionFile or role_owner)
  - `monitoring`: route has no POLARIS.md cognition
  - `recovering`: route was stale but recently updated (7-30 days old)
  - `healthy`: fresh, identity complete, has cognition
- Route health state is persisted per route to `route-health.json` in the map sidecar output path (`applyRouteCognitionDelta` writes it for every atlas route); `src/map/welfare.ts` and `src/medic/route-exam.ts` read this persisted state rather than recomputing it.
- SUMMARY.md size cap is a hard error; doctrine bleed detection is warn-only.
- `isCognitionSkippedFolder` is the single authority on excluded folders, including the top-level `.polaris` runtime surfaces that now carry cognition while nested run, cluster, map, and graph artifacts stay excluded.

## Relationships
- **Called by**: `src/loop/worker.ts` after each child completes; `src/smartdocs-engine` during ingest
- **Reads**: file path patterns only — no file content inspection for delta signals

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
