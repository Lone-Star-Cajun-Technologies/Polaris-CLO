# Summary: specs/active

## Purpose
Current canonical SmartDocs specs.

## Key behaviors
- Live spec surface for implementation and validation.
- Should stay aligned with active doctrine.
- Includes active integration analysis for POL-325 in
  [pol-325-codegraph-integration-analysis.md](pol-325-codegraph-integration-analysis.md).
- Includes the fully implemented Worker Router architecture spec for POL-463 in
  [worker-router-architecture.md](worker-router-architecture.md). All 6 delivery stages
  (POL-464 through POL-469) are complete: architecture documented, config/types added,
  deterministic engine implemented, slot-aware scheduling integrated, adapter fallback
  wired, and SOL telemetry emitted.
- Includes the Quality Control architecture spec for POL-471 in
  [quality-control-architecture.md](quality-control-architecture.md). It defines provider
  boundaries, trigger policy (PR/completed-cluster default, child-level gated), severity,
  attribution, auto-fix limits, repair routing, and SOL feedback boundaries.

## Relationships
- **Parent**: `smartdocs/specs/`
- **Linked canonical source**: [POLARIS.md](POLARIS.md)
