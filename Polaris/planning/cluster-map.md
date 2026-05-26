> Source: git-fit/docs/evonotes/planning-specs/ — canonical Polaris architecture reference

# Polaris Cluster Map

**Parent:** POL-1

This document maps the 7 Polaris implementation clusters, their Linear IDs, and dependency order.

## Cluster Overview

| Cluster | Linear ID | Title | Dependencies |
|---------|-----------|-------|--------------|
| Cluster 1 | POL-2 | Bootstrap repo structure and temporary taskchain harness | None |
| Cluster 2 | POL-3 | Polaris CLI / config / ignore foundation | POL-2 |
| Cluster 3 | POL-4 | Polaris map — index / backfill / update / validate | POL-3 |
| Cluster 4 | POL-5 | Polaris loop — checkpoint / resume / boundary enforcement | POL-4 |
| Cluster 5 | POL-6 | Polaris finalize — atomic delivery sequence | POL-5 (loop), POL-4 (map) |
| Cluster 6 | POL-7 | EVO skill integration — evo-run and evo-analyze | POL-5, POL-6 |
| Cluster 7 | POL-8 | Adoption — git-fit atlas and guide | POL-4 only |

## Dependency Graph

```
POL-2 (Cluster 1: Bootstrap)
  └── POL-3 (Cluster 2: CLI/config/ignore)
        └── POL-4 (Cluster 3: Map)
              └── POL-5 (Cluster 4: Loop)
                    └── POL-6 (Cluster 5: Finalize)
                          └── POL-7 (Cluster 6: EVO integration)

POL-8 (Cluster 7: Adoption) ← POL-4 only
```

## Execution Order

Execute clusters in numerical order (POL-2 → POL-3 → POL-4 → POL-5 → POL-6 → POL-7 → POL-8).

Within each cluster, execute children in numerical order (e.g., POL-9 → POL-10 → POL-11 → POL-12 → POL-13 for Cluster 1).

## Cluster Summaries

### Cluster 1 (POL-2): Bootstrap
Create minimal repo structure, CLAUDE.md/AGENTS.md, planning doc copies, temporary bootstrap skill, artifact scaffold. No Polaris CLI code yet.

### Cluster 2 (POL-3): CLI/config/ignore
Create `polaris` CLI entry point (Node.js/TypeScript), config schema, ignore parser, config loader. Scaffolding only.

### Cluster 3 (POL-4): Map
Implement `polaris map index`, `polaris map backfill`, `polaris map update --changed`, `polaris map validate`, `polaris map query`. Generate `.polaris/map/` atlas.

### Cluster 4 (POL-5): Loop
Implement `polaris loop continue`, `polaris loop status`, `polaris loop resume`, `polaris loop abort`. Implement analyze→implementation boundary enforcement.

### Cluster 5 (POL-6): Finalize
Implement full 12-step finalize sequence: map validate, schema validate, checks, run-report, commit, push, PR, state update, JSONL, Linear, archive.

### Cluster 6 (POL-7): EVO Integration
Update evo-run step 07 to call `polaris loop continue`. Update evo-run step 08 to use `polaris finalize`. Update evo-analyze to use Polaris loop/map. Replace bootstrap-run skill.

### Cluster 7 (POL-8): Adoption
Run `polaris map index` on git-fit, complete `polaris.config.json` for git-fit, write `.polarisignore`, publish adoption guide.

## Phased Delivery

| Phase | Clusters | What it delivers |
|---|---|---|
| 1 — Core infrastructure | POL-2, POL-3, POL-4 | Repo CLI, atlas: index + changed-file mapping |
| 2 — Loop and session management | POL-5, POL-6 | Bootstrap packets, boundary enforcement, finalize |
| 3 — EVO skill integration | POL-7 | Full EVO skill chain adoption |
| 4 — Adoption | POL-8 | git-fit atlas populated; guide published |

Phase 1 delivers standalone value (repo map) independent of EVO skill chain changes.
