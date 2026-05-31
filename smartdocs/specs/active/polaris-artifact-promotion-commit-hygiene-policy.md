---
kind: spec
status: active
source: POL-240
created: 2026-05-31
implements: POL-242
related: POL-243, POL-244, POL-245, POL-246, POL-247, POL-248
supersedes:
superseded_by:
depends_on: POL-201
validates:
source_paths: src/finalize/artifact-policy.ts,src/finalize/POLARIS.md
---

# Polaris Artifact Promotion and Commit Hygiene Policy

**Status:** active spec  
**Analysis source:** POL-240  
**Implementation issue:** POL-242

---

## 1. Purpose

This spec defines which Polaris-owned artifacts are durable delivery evidence, which are live workspace scratch, and which legacy surfaces must stay out of finalize commits. The goal is to keep delivery commits reviewable while preserving enough committed evidence for replay, auditing, and resume-state migrations.

## 2. Artifact classes

| Class | Paths | Commit policy |
|---|---|---|
| Promoted cluster evidence | `.polaris/clusters/<active-cluster>/clusters.json`, `.polaris/clusters/<active-cluster>/cluster-state.json`, `.polaris/clusters/<active-cluster>/packets/**`, `.polaris/clusters/<active-cluster>/results/**` | Commit-eligible |
| Promoted run ledger | `.polaris/runs/ledger.jsonl` | Commit-eligible |
| Promoted atlas output | `.polaris/map/**` | Commit-eligible |
| Workspace scratch | `.taskchain_artifacts/**`, `*.bak` | Never promote into delivery commits |
| Legacy run artifacts | `.polaris/runs/mutation-queue.json`, `.polaris/runs/current-state.pre-pol-198.json`, `.polaris/runs/evo-run-archive/**` | Keep out of delivery commits |
| Foreign cluster evidence | `.polaris/clusters/<other-cluster>/**` | Keep out of the active cluster's delivery commit |

Non-artifact repository changes (for example `src/**`, `smartdocs/**`, config files, or tests) follow normal implementation review flow; this policy only governs Polaris-managed artifact surfaces.

## 3. Promotion flow

1. Live execution writes mutable workspace state under `.taskchain_artifacts/`.
2. Durable execution evidence is written under `.polaris/clusters/<active-cluster>/` and `.polaris/runs/ledger.jsonl`.
3. Finalize may promote only the durable evidence surfaces listed above, plus intentional source/document changes made by the child implementation.
4. Raw telemetry, backup files, workspace drafts, and foreign-cluster noise must remain unstaged.

## 4. Commit-hygiene rules

- Never treat `.taskchain_artifacts/` as a commit source during finalize.
- Never stage backup files or compatibility snapshots as delivery evidence.
- Never mix artifacts from a previous cluster into the active cluster's finalize commit.
- Keep tracker mutation queues and other workspace-owned run files outside durable delivery commits until they are explicitly relocated or reclassified by canon.

## 5. Enforcement contract

`src/finalize/artifact-policy.ts` is the source-of-truth classifier for this spec. Finalize and related validation steps must consume that classifier instead of duplicating path rules inline. The classifier must:

- identify promoted Polaris artifacts for the active cluster,
- flag workspace scratch and legacy run artifacts as hygiene violations, and
- ignore non-artifact implementation files so normal code review still governs them.

## 6. Minimum committed resume-state contract

`.taskchain_artifacts/polaris-run/current-state.json` remains workspace scratch, but committed cluster evidence must still be sufficient to rebuild the minimum resume state when that workspace file is missing.

### 6.1 Field audit

| `LoopState` field | Resume source | Contract |
|---|---|---|
| `schema_version` | Reconstructed default | Rebuild as the current loop-state schema version. |
| `run_id` | Bootstrap packet | Must come from the selected bootstrap packet. |
| `cluster_id` | `cluster-state.json` | Must be present in committed cluster state. |
| `branch` | Bootstrap packet | Must come from the selected bootstrap packet. |
| `session_type` | Reconstructed default | Resume fallback may default to `implement` when no committed override exists. |
| `active_child` | Bootstrap packet + `child_states` | Must resolve to the first still-open child, preferring dispatched/running work when present. |
| `completed_children` | `child_states` | Derive from committed child statuses marked `done` or `finalized`. |
| `open_children` | Bootstrap packet, validated against `child_states` | Packet order is canonical when the ids still exist in committed cluster state. |
| `step_cursor` | Bootstrap packet | Reuse `last_completed_step`. |
| `context_budget.children_completed` | Bootstrap packet | Reuse the packet counter. |
| `status` | Reconstructed default | Resume fallback should restore `running` unless a stronger committed contract is introduced later. |
| `last_commit` | `commits` map | Use the commit recorded for `last_completed_child`, or the latest committed child hash. |
| `next_open_child` | Bootstrap packet + `open_children` | Use the first remaining open child after reconstruction. |
| `artifact_dir` | Repository-local convention | Rebuild as `.taskchain_artifacts/polaris-run`. |
| `blocker`, `dispatch_boundary`, `run_bootstrap_seal`, `open_children_meta`, `completed_children_results` | Not committed today | These fields are optional for resume and must not be required when only committed cluster evidence is available. |

### 6.2 Committed minimum

The minimum committed contract for resume is therefore:

1. a bootstrap packet with `run_id`, `branch`, `last_completed_step`, `last_completed_child`, `open_children`, and `context_budget.children_completed`; and
2. `.polaris/clusters/<active-cluster>/cluster-state.json` with `cluster_id`, `child_states`, and `commits`.

If that contract is present, `polaris loop resume` must rebuild `current-state.json`, emit a fresh `current_state_sha`, and continue. If the contract is incomplete, resume must fail with a clear reconstruction error instead of a raw file-not-found.
