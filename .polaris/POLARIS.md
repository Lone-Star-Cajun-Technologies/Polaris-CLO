# .polaris

## Purpose

`.polaris/` is the repository-owned sidecar namespace for Polaris runtime artifacts and packaged runtime support assets. It holds durable top-level folders for bootstrap snapshots, cluster execution artifacts, archived runs, atlas outputs, and shipped roles/skills.

## What belongs here

- `bootstrap/` — sealed bootstrap snapshot files for dispatched runs
- `clusters/` — per-cluster packets, results, and cluster-state artifacts
- `runs/` — run ledger plus archived run snapshots
- `map/` — derived atlas outputs (`file-routes.json`, `needs-review.json`, `index.json`, `exemptions.json`)
- `roles/`, `skills/`, `session-type/` — packaged Polaris operator assets checked into source

## What does not belong here

- Live session state under `.taskchain_artifacts/`
- Source modules from `src/`
- Hand-authored per-run or per-cluster cognition files inside generated descendants

## Editing rules

- Keep cognition at the top-level runtime folders only; do not add `POLARIS.md` or `SUMMARY.md` inside generated run or cluster ID directories.
- Treat `bootstrap/`, `clusters/`, `runs/`, and `map/` contents as derived/runtime data unless a source module explicitly owns the write path.
- Update packaged skills and roles here only when their checked-in source contract changes.

## Architecture assumptions

- `.polaris/` is repository-local state, not an external cache.
- Runtime artifact writers in `src/loop/`, `src/finalize/`, `src/map/`, and `src/cluster-state/` own the file formats stored here.
- Top-level cognition exists to explain the folder contracts without turning generated descendants into canonical source.

## Read before editing

- [`src/loop/dispatch.ts`](../src/loop/dispatch.ts)
- [`src/finalize/steps/12-archive.ts`](../src/finalize/steps/12-archive.ts)
- [`src/map/POLARIS.md`](../src/map/POLARIS.md)

## Related routes

- `.polaris/bootstrap`
- `.polaris/clusters`
- `.polaris/map`
- `.polaris/runs`
