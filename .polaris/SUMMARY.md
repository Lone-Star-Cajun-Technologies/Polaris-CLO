# Summary: .polaris

## Purpose
Hidden sidecar namespace for Polaris-owned runtime artifacts, atlas outputs, and packaged operator assets.

## Key behaviors
- Top-level runtime folders under `.polaris/` now carry cognition surfaces.
- Generated run and cluster descendants remain runtime artifacts, not route-local canon.
- Source modules in `src/` own the data contracts written here.

## Relationships
- **Written by**: `src/loop`, `src/finalize`, `src/map`, `src/cluster-state`
- **Read by**: operators, validators, and future workers resolving runtime state

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `../smartdocs/docs/specs/active/worker-session-contract.md`
