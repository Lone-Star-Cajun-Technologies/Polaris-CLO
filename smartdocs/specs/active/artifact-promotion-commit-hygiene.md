---
title: Polaris Artifact Promotion and Commit Hygiene Policy
status: active
type: spec
implements: POL-240
related:
  - POL-201
  - POL-234
---

# Polaris Artifact Promotion and Commit Hygiene Policy

## Problem

PR review on POL-234 and prior runs exposed a systematic commit hygiene problem: Polaris finalize stages live workspace state (`.taskchain_artifacts/polaris-run/current-state.json`) in delivery commits instead of durable execution evidence. This, combined with `.taskchain_artifacts/` being fully git-tracked, means PRs include backup files, multi-skill state, raw telemetry, and workspace scratch that reviewers cannot distinguish from real source changes.

The secondary problem is that `mutation-queue.json` — an active workspace file — lives in `.polaris/runs/` (a durable artifact path), causing it to appear in `git status` as a modified tracked file and block branch switching.

## Root Cause: Finalize Step Ordering

The finalize delivery sequence is:

```
01-map-update → 02-map-validate → 03-schema-validate → 04-run-checks →
05-generate-report → 06-commit → 07-push → 08-create-pr →
09-update-state → 10-append-jsonl → 11-update-linear → 12-archive
```

`06-commit.ts` currently stages:
- `stateFile` = `.taskchain_artifacts/polaris-run/current-state.json` (live workspace state — WRONG)
- `reportPath` = `.taskchain_artifacts/polaris-run/run-report.md` (active draft — WRONG)
- `mapDir` = `.polaris/map/` (derived atlas output — CORRECT)

`12-archive.ts` runs AFTER the commit, so the durable archived evidence is never included in the delivery commit.

`.polaris/clusters/<id>/cluster-state.json` — the actual durable execution record — is never staged by finalize.

## Artifact Classification Matrix

### Commit-eligible (`.polaris/` durable surfaces)

| Artifact | Path | Notes |
|---|---|---|
| Cluster plan | `.polaris/clusters/<id>/clusters.json` | Already staged; no change needed |
| Cluster execution state | `.polaris/clusters/<id>/cluster-state.json` | Must be staged by `06-commit.ts` |
| Worker packets | `.polaris/clusters/<id>/packets/<id>.json` | Evidence; commit when present |
| Worker results | `.polaris/clusters/<id>/results/<id>.json` | Evidence; commit when present |
| Run ledger | `.polaris/runs/ledger.jsonl` | Append-only audit; stage in commit |
| Atlas map | `.polaris/map/` | Already staged; no change needed |

### Not commit-eligible — gitignore (`.taskchain_artifacts/` workspace)

| Artifact | Pattern | Notes |
|---|---|---|
| Orchestrator live state | `.taskchain_artifacts/polaris-run/current-state.json` | Workspace scratch |
| Compatibility shim | `.taskchain_artifacts/polaris-run/remaining-state.json` | Workspace compat layer |
| Pre-flight backups | `.taskchain_artifacts/polaris-run/current-state.json.*.bak` | Transient |
| Run report draft | `.taskchain_artifacts/polaris-run/run-report.md` | Draft, not final |
| All skill current-state | `.taskchain_artifacts/*/current-state.json` | Live workspace for all skills |
| Mutation queue | `.polaris/runs/mutation-queue.json` | Active workspace, wrong location |

### Optional retention (telemetry)

| Artifact | Pattern | Policy |
|---|---|---|
| Raw run telemetry | `.taskchain_artifacts/*/runs/*/telemetry.jsonl` | Keep in git for now; do not stage in PRs |

### Remove from tracking (deprecated)

| Artifact | Path |
|---|---|
| Deprecated bootstrap state | `.taskchain_artifacts/bootstrap-run/` |
| Deprecated evo-run archive | `.polaris/runs/evo-run-archive/` |
| Legacy state snapshot | `.polaris/runs/current-state.pre-pol-198.json` |

## Proposed Commit Allowlist

Files staged by `06-commit.ts` must come from this list only:

```
.polaris/clusters/<active-cluster-id>/cluster-state.json
.polaris/clusters/<active-cluster-id>/clusters.json
.polaris/clusters/<active-cluster-id>/packets/
.polaris/clusters/<active-cluster-id>/results/
.polaris/runs/ledger.jsonl
.polaris/map/
src/**   (source changes from child implementations)
smartdocs/**  (doc changes from child implementations)
```

Files that must never be staged:

```
.taskchain_artifacts/**   (all workspace scratch)
.polaris/runs/mutation-queue.json
*.bak
.polaris/clusters/<OTHER-cluster-ids>/   (prior run noise)
```

## Proposed Artifact Promotion Flow

```
Active execution
  └─ .taskchain_artifacts/polaris-run/current-state.json  (live workspace — gitignored)
  └─ .polaris/clusters/<id>/cluster-state.json            (durable — written every dispatch)

Finalize commit (06-commit.ts, updated)
  └─ stages .polaris/clusters/<id>/cluster-state.json
  └─ stages .polaris/clusters/<id>/packets/ + results/
  └─ stages .polaris/runs/ledger.jsonl
  └─ stages .polaris/map/
  └─ stages source changes

Post-delivery archive (12-archive.ts, unchanged)
  └─ .polaris/runs/<run-id>/current-state.json  (audit snapshot)
  └─ .polaris/runs/<run-id>/run-report.md
  └─ .polaris/runs/<run-id>/file-routes.json etc
```

## Resume-State Minimum Contract

For `polaris loop continue` to resume after machine shutdown, branch switch, or provider session loss, the minimum committed state is:

1. `.polaris/clusters/<id>/cluster-state.json` — child states, packet pointers, result pointers, commits
2. `.taskchain_artifacts/polaris-run/current-state.json` — orchestrator state (currently required; see migration note below)

**Migration note**: The orchestrator live state (`.taskchain_artifacts/polaris-run/current-state.json`) is read by `readState()` in `src/loop/checkpoint.ts` and used throughout `src/loop/parent.ts`. For resume to work from `.polaris/clusters/` alone, all fields in `LoopState` that are not derivable from `cluster-state.json` must either be preserved or made reconstructible.

The migration path (scope of a dedicated child issue) is:
1. Identify fields in `LoopState` not present in `ClusterState`
2. Either add those fields to `ClusterState` or document them as reconstructible from Linear
3. Update `src/loop/resume.ts` to attempt `cluster-state.json` fallback when `.taskchain_artifacts` state is absent
4. Gitignore the live state file only after the resume path is verified

Until the resume migration is complete, `.taskchain_artifacts/polaris-run/current-state.json` should remain tracked but excluded from finalize commit staging.

## Enforcement Plan

### .gitignore rules (immediate)

```gitignore
# Polaris workspace scratch — never commit
.taskchain_artifacts/*/current-state.json
.taskchain_artifacts/*/remaining-state.json
.taskchain_artifacts/*/run-report.md
.taskchain_artifacts/**/*.bak
.polaris/runs/mutation-queue.json
```

### Finalize preflight check (04-run-checks.ts)

Add checks that fail or warn when:
- Any `.taskchain_artifacts/` file is staged
- Any `.bak` file is staged
- Any `.polaris/clusters/<id>/` directory is staged where `<id>` is not the active cluster

### mutation-queue.json relocation

Change default path in `src/tracker/sync/queue-store.ts` and `src/tracker/sync/index.ts` from `.polaris/runs/mutation-queue.json` to `.taskchain_artifacts/polaris-run/mutation-queue.json`. Add `git rm --cached` migration for existing tracked file.
