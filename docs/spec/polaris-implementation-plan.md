# Polaris Implementation Plan

## Issue Hierarchy

Polaris implementation clusters use a separate ANALYZE parent and IMPLEMENT parent. The ANALYZE issue records research and planning; the IMPLEMENT parent owns executable children and is the only parent that `polaris-run` targets.

See `docs/spec/issue-hierarchy-doctrine.md` for the canonical hierarchy doctrine, migration rules for existing ANALYZE-as-parent clusters, and the `gitBranchName` convention for IMPLEMENT parents.
