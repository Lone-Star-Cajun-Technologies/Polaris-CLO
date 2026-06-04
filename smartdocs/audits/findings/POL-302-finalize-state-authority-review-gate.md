---
source: smartdocs/audits/findings/POL-302-finalize-state-authority-review-gate.md
ingest-run-id: migrated
classified-as: audit-finding
linked-map-area: src/finalize
ingested-at: 2026-06-04T06:15:00.000Z
status: raw
---

# POL-302 Analysis: Finalize State Authority and Linear Review-Gate Lifecycle

**Date:** 2026-06-03
**Analyze run:** polaris-analyze-finalize-state-authority-2026-06-03-001
**Source issue:** POL-302

---

## 1. Root Cause Summary — POL-296/POL-289 Finalize Mismatch

During the POL-296 run, `polaris finalize run` was invoked with an explicit `--state-file` pointing to `.taskchain_artifacts/polaris-run/current-state.json`. That file contained stale POL-289 state (`run_id: polaris-run-pol-289-2026-06-03-001`, `cluster_id: POL-289`, `status: cluster-complete`). The finalizer trusted the state file uncritically and generated PR #95 with the POL-289 run ID in its title and body. The PR contained POL-296 commits but was labeled as a POL-289 delivery.

Five gaps in the finalize pipeline collectively permitted this:

### Gap 1 — Non-canonical state path accepted without warning

`src/finalize/index.ts:381` accepts any path passed as `--state-file`. `src/loop/status.ts:147` classifies `.taskchain_artifacts/polaris-run/current-state.json` as `"compatibility/debug"` — not canonical — but finalize never consults that classification. The compatibility path is a side-write for observability and should never drive delivery.

### Gap 2 — Branch custody check skipped when cluster has no delivery_branch

The branch custody check at `src/finalize/index.ts:179–225` guards against running finalize on the wrong branch, but only fires when `clusterState.delivery_branch` is non-null. POL-289's `cluster-state.json` was created before the custody fields were introduced and has `delivery_branch: null`. The check was unconditionally bypassed.

### Gap 3 — No run_id / branch / cluster_id cross-validation

`src/finalize/github.ts:13` sets the PR title to `polaris finalize: ${state.run_id}` with no check that `state.run_id` belongs to the current branch or cluster. `LoopState.branch` exists (`src/loop/checkpoint.ts:156`) but finalize never compares `state.branch` to the current git branch. `state.cluster_id` is never compared to the branch slug.

### Gap 4 — Delivery integrity gate passes on wrong-cluster commits

`src/finalize/index.ts:232–265` verifies the delivery branch has non-artifact implementation changes relative to base. It uses `state.cluster_id` for child commit lookup, but when the cluster ID is wrong (POL-289), the commit lookup falls back gracefully and the check passes because POL-296 commits are legitimately present on the branch. The gate detects absent implementation, not mismatched implementation.

### Gap 5 — No explicit policy preventing Done transitions

`src/finalize/linear.ts` currently only calls `commentCreate` — no status transition. This is correct but undocumented and unenforced. There is no role-level or CLI-level prohibition preventing a future change from adding a Done transition.

---

## 2. State Authority Model for Finalize

### Canonical state sources (in authority order)

| Source | Path | Classification | Role |
|--------|------|---------------|------|
| Cluster state | `.polaris/clusters/<cluster_id>/cluster-state.json` | **canonical** | Live execution authority; delivery_branch, base_branch, child commits |
| Bootstrap packet | `.polaris/clusters/<cluster_id>/packets/<id>.json` | **derived** | Sealed handoff snapshot; read-only reference |
| Polaris runs current-state | `.polaris/runs/current-state.json` | **legacy** | Transitional snapshot; must not drive delivery |
| Compatibility current-state | `.taskchain_artifacts/polaris-run/current-state.json` | **compatibility** | Debug/observability side-write; must not drive delivery |

### Authority rules

1. **Finalize must read its run state from the bootstrap packet or from a path that can be cross-validated against cluster state.**
2. **The compatibility path (`.taskchain_artifacts/polaris-run/current-state.json`) must never be accepted as a `--state-file` argument for delivery finalization.**
3. **The legacy path (`.polaris/runs/current-state.json`) should also be refused or at minimum require explicit `--allow-legacy-state` acknowledgement.**
4. **PR metadata (title, body) must derive from `state.cluster_id`, not `state.run_id` alone.**
5. **`state.cluster_id` must be cross-validated against the current git branch before any delivery step proceeds.**

---

## 3. Required Finalize Preflight Validations

These validations must be added to `src/finalize/index.ts` as new preflight steps, before Step 4 (run checks), aborting on failure:

### Preflight A — State-file path authority gate

```
ABORT if stateFile matches any of:
  - <repoRoot>/.taskchain_artifacts/polaris-run/current-state.json
  - <repoRoot>/.polaris/runs/current-state.json  (unless --allow-legacy-state flag)

Error: "finalize aborted: state file '<path>' is a <compatibility|legacy> surface and
may not drive delivery. Use the run's bootstrap packet or canonical state path."
```

### Preflight B — Branch/cluster agreement

```
ABORT if state.cluster_id cannot be matched to the current branch name.

Matching rule: branch name must contain a slug derived from state.cluster_id
(e.g., branch "pol-296-delivery" contains "pol-296" which matches cluster_id "POL-296").
Case-insensitive, hyphen-normalized.

Error: "finalize aborted: cluster mismatch — state.cluster_id '<X>' does not match
current branch '<branch>'. Expected branch to contain '<slug>'."
```

### Preflight C — state.branch agreement (when populated)

```
If state.branch is non-empty:
  ABORT if state.branch !== current git branch.

Error: "finalize aborted: branch mismatch — state.branch '<X>' recorded at bootstrap
does not match current branch '<Y>'."
```

### Preflight D — State recency check

```
ABORT if state.status is "cluster-complete" but state.completed_children count is 0.

Error: "finalize aborted: state integrity check failed — state.status is
'cluster-complete' but completed_children is empty. This indicates a stale or
corrupt state file that must not drive delivery."
```

Rationale: a `cluster-complete` state with zero completed children is definitively
inconsistent — no valid run produces this combination. The primary mismatch guards
(Preflights A–C) prevent most stale-state scenarios, but this check closes the gap
for states that pass those guards yet still record impossible completion metadata.

---

## 4. Required PR Metadata Validations

### Title format

Current: `polaris finalize: ${state.run_id}`

Required change: `polaris finalize: ${state.cluster_id} (${state.run_id})`

This makes the cluster ID the primary identifier in the PR title and demotes the run ID to a parenthetical. A CI/search scan for "polaris finalize: POL-296" will find the correct PR.

### Body validation

Add to PR body:
- `**Cluster ID:** ${state.cluster_id}`
- `**Branch:** ${branch}` (already present — verify it is the live branch, not state.branch)

### Cross-validation before gh pr create

Before calling `gh pr create`, verify:
1. `state.cluster_id` is present and non-empty
2. `branch` contains a slug derived from `state.cluster_id`
3. `state.run_id` starts with the cluster ID slug (e.g., `polaris-run-pol-296-*`)

If any check fails: abort with a specific message before creating the PR.

---

## 5. Linear Lifecycle Policy Proposal

### Current behavior

`src/finalize/steps/11-update-linear.ts` calls `postLinearComment` which calls `commentCreate` only. No issue state transition is performed.

### Required policy

| Event | Current behavior | Required behavior |
|-------|-----------------|-------------------|
| polaris finalize completes | Comment posted; issue state unchanged | Attempt transition to `In Review`; if not available, leave open and post comment |
| Human approves PR and merges | Not tracked by Polaris | Human moves issue to Done in Linear |
| polaris loop abort | Comment posted (optional) | Issue state unchanged |

### Implementation rules

1. **Finalize must attempt to move the parent Linear issue to an `In Review` (or equivalent) state after successful delivery.** It must never transition to `Done` or `Closed`.
2. **If no review state is configured or available:** leave the issue in its current state and post a comment referencing the draft PR URL.
3. **No Polaris component — CLI, agent, or role — may call `issueUpdate` with a `Done` or `Closed` state ID.** This prohibition must appear in:
   - `src/finalize/linear.ts` (code enforcement)
   - `.polaris/roles/` role files (doctrine enforcement)
4. **Review state lookup:** finalize queries all available states for the issue's team and selects using this deterministic priority:
   1. First state whose name matches (case-insensitive) `"In Review"` exactly
   2. First state whose name matches (case-insensitive) `"Review"` exactly
   3. First state with `type === "review"` in the Linear state type enum
   4. If none of the above match: post-comment-only fallback (no `issueUpdate` call)

   This ordering ensures that explicitly named review states take precedence over generic type-based matches, and that the selection is deterministic when multiple candidate states exist.

### Fallback behavior specification

```
if review_state_id exists:
    issueUpdate(issueId, { stateId: review_state_id })
    commentCreate(issueId, "polaris finalize complete — moved to In Review. PR: <url>")
else:
    commentCreate(issueId, "polaris finalize complete — no In Review state configured.
    PR: <url>. Please move to Done after human review.")
```

---

## 6. Recommended Implementation Plan

Four implementation children under a single IMPLEMENT parent (linked to POL-302):

### Child 1 — State-file authority gate + branch/cluster cross-validation
**File:** `src/finalize/index.ts`
Add Preflight A (state-file path rejection), Preflight B (cluster/branch agreement), Preflight C (state.branch check) before the existing Step 4. Unit tests in `src/finalize/finalize.test.ts`.

### Child 2 — PR metadata hardening
**File:** `src/finalize/github.ts`
Change PR title format to include `cluster_id`. Add pre-creation cross-validation. Unit tests covering mismatched cluster_id.

### Child 3 — Linear review-gate implementation
**Files:** `src/finalize/linear.ts`, `src/finalize/steps/11-update-linear.ts`
Add review-state lookup query, conditional `issueUpdate` to In Review, fallback to comment-only. Prohibit Done/Closed transitions explicitly in code. Unit tests for both paths (review state found / not found).

### Child 4 — Role doctrine enforcement
**Files:** `.polaris/roles/finalizer.md`, `.polaris/roles/worker.md`, `.polaris/roles/foreman.md`
Add explicit prohibition: "Agents may not transition Linear issues to Done or Closed. Finalize moves issues to In Review at most."

### Execution order

Children 1, 2, and 3 are independent and may be dispatched concurrently. Child 4 depends on Child 3 completing (doctrine should reflect implemented behavior).

---

## 7. Test Cases That Must Exist Before This Is Considered Fixed

| Test | Location | Verifies |
|------|----------|---------|
| finalize aborts when --state-file is compatibility path | `src/finalize/finalize.test.ts` | Gap 1 (state path gate) |
| finalize aborts when --state-file is legacy path (without flag) | `src/finalize/finalize.test.ts` | Gap 1 (state path gate) |
| finalize aborts when cluster_id does not match branch name | `src/finalize/finalize.test.ts` | Gap 3 (cluster/branch agreement) |
| finalize aborts when state.branch is set and differs from current branch | `src/finalize/finalize.test.ts` | Gap 3 (state.branch check) |
| PR title contains cluster_id as primary identifier | `src/finalize/finalize.test.ts` | Gap 3 (PR metadata) |
| Linear update transitions to In Review when state available | `src/finalize/linear.ts` tests | Gap 5 (review-gate) |
| Linear update posts comment only when no In Review state | `src/finalize/linear.ts` tests | Gap 5 (review-gate fallback) |
| Linear update never calls Done/Closed state transition | `src/finalize/linear.ts` tests | Gap 5 (Done prohibition) |
| finalize proceeds normally when all validations pass | `src/finalize/finalize.test.ts` | Regression — happy path |

---

## Appendix: Files and Execution Flows Inspected

| File | Domain | Finding |
|------|--------|---------|
| `src/finalize/index.ts` | finalize | State file read, branch custody, delivery integrity, Linear call |
| `src/finalize/github.ts` | finalize | PR title derives from `state.run_id` only |
| `src/finalize/linear.ts` | finalize | `commentCreate` only; no state transition |
| `src/finalize/steps/11-update-linear.ts` | finalize | Delegates to `linear.ts` |
| `src/finalize/steps/04-run-checks.ts` | finalize | Artifact preflight; no run/branch cross-check |
| `src/loop/checkpoint.ts` | loop | `LoopState.branch` field exists but unused by finalize |
| `src/cluster-state/store.ts` | cluster-state | `ClusterState.delivery_branch` optional; null for old clusters |
| `src/cluster-state/types.ts` | cluster-state | Type definitions |
| `src/loop/run-bootstrap.ts` | loop | Seal cross-validates `run_id`/`cluster_id` but not branch |
| `src/loop/status.ts` | loop | Defines "canonical" vs "compatibility" vs "legacy" surfaces |
| `.taskchain_artifacts/polaris-run/current-state.json` | artifact | Stale POL-289 compatibility state used during incident |
| `.polaris/clusters/POL-289/cluster-state.json` | artifact | `delivery_branch: null` — caused custody skip |
