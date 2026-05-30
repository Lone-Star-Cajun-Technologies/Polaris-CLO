# Summary: bootstrap

## Purpose
Append-only bootstrap evidence for Polaris runs.

## Key behaviors
- Each file captures a sealed snapshot of run inputs at bootstrap time.
- Bootstrap snapshots support resume and audit flows but are not live state.
- Cognition stops at this folder; individual snapshot files remain generated artifacts.

## Relationships
- **Written by**: `src/loop/run-bootstrap.ts`, `src/loop/resume.ts`
- **Related state**: `.taskchain_artifacts/polaris-run/`, `.polaris/runs/`

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `../../src/loop/run-bootstrap.ts`
