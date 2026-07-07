# Summary: smartdocs

## Purpose
Vault-level context for SmartDocs. This is the documentation origin for the repository.

## Key behaviors
|- Root config stays in `.obsidian/`.
|- Canonical content lives directly at `smartdocs/` (architecture/, doctrine/, specs/, integrations/, audits/, decisions/, raw/, medic/).
|- SmartDocs directories may carry OKF-style `index.md` files for local concept navigation; lifecycle commands write dated `log.md` files in doctrine/spec destination directories.
|- The `docs/` nesting layer has been removed; all paths are now canonical root-relative.
|- `medic/charts/` stores Medic diagnostic charts in `CHART-YYYY-MM-DD-NNN.md` format, written by the Medic role.
|- Generated artifacts in `runtime/` are excluded from cognition.

## Relationships
|- **Contains**: `architecture/`, `doctrine/`, `specs/`, `integrations/`, `audits/`, `decisions/`, `raw/`, `medic/`, `runtime/`
|- **Linked canonical source**: [POLARIS.md](POLARIS.md)
|- **Active policy spec**: [specs/active/polaris-artifact-promotion-commit-hygiene-policy.md](specs/active/polaris-artifact-promotion-commit-hygiene-policy.md) defines durable Polaris artifact promotion versus workspace scratch.
|- **Active QC spec**: [specs/active/quality-control-architecture.md](specs/active/quality-control-architecture.md) defines the Quality Control layer boundaries, trigger policy, and lifecycle.
