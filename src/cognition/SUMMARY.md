# Summary: cognition

## Purpose
Delta-only signal library for route-local cognition surfaces — determines when `POLARIS.md` or `SUMMARY.md` updates are warranted, validates constraints, and identifies missing surfaces.

## Key behaviors
- Returns signals only; callers own all writes to disk.
- Cognition is scoped per directory, walking upward from touched files; root excluded by default.
- SUMMARY.md size cap is a hard error; doctrine bleed detection is warn-only.
- `isCognitionSkippedFolder` is the single authority on excluded folders, including the top-level `.polaris` runtime surfaces that now carry cognition while nested run, cluster, map, and graph artifacts stay excluded.

## Relationships
- **Called by**: `src/loop/worker.ts` after each child completes; `src/smartdocs-engine` during ingest
- **Reads**: file path patterns only — no file content inspection for delta signals

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
