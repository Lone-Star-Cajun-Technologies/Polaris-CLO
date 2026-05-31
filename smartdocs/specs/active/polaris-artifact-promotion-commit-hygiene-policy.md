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

## 6. Resume-state note

This policy does not by itself remove `.taskchain_artifacts/polaris-run/current-state.json` from repository history. Resume-state fallback from `.polaris/clusters/<id>/cluster-state.json` remains a separate contract tracked by POL-248.
