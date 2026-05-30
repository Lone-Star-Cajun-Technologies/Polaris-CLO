---
kind: doctrine
status: active
candidate-since: 2026-05-28
source: smartdocs/docs/raw/polaris-implementation-plan.md
doc-type: doctrine
confidence: 0.75
recommended-action: promote
overlap-analysis: Thin stub; defers to issue-hierarchy-doctrine.md for hierarchy rules. No conflicting content with existing active doctrine. Useful as a stable reference pointer.
implements: ""
related: smartdocs/docs/doctrine/active/issue-hierarchy-doctrine.md
supersedes: ""
superseded_by: ""
depends_on: ""
validates: ""
source_paths: ""
---

# Polaris Implementation Plan

## Issue Hierarchy

Polaris implementation clusters use a separate ANALYZE parent and IMPLEMENT parent. The ANALYZE issue records research and planning; the IMPLEMENT parent owns executable children and is the only parent that `polaris-run` targets.

See `docs/spec/issue-hierarchy-doctrine.md` for the canonical hierarchy doctrine, migration rules for existing ANALYZE-as-parent clusters, and the `gitBranchName` convention for IMPLEMENT parents.
