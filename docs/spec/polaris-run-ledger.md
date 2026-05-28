# Polaris Run Ledger Specification

Authoritative specification for the global Polaris run ledger. This document defines the architecture, JSONL event schema, resume algorithm, storage strategy, conflict rules, CLI command surface, cross-agent handoff protocol, and migration path from the bootstrap-packet-only model.

Source note: the event model and requirements come from POL-147, "ANALYZE: Add global Polaris run ledger for cross-agent resume and overlapping runs." POL-147 identified 11 ledger events and the required resume fields. This spec preserves that event list exactly and makes the implementation decisions explicit.

---

## 1. Responsibilities

Polaris has three durable state surfaces. They are complementary, not interchangeable.

| Surface | Path | Responsibility | Required for resume? | Mutability |
|---|---|---|---|---|
| Global run ledger | `.polaris/runs/ledger.jsonl` | Compact, committed, append-only resume index for all Polaris run types across agents, branches, and worktrees. | Yes | Append-only |
| Current state | `.taskchain_artifacts/polaris-run/current-state.json` during the current migration phase; eventual per-run snapshots may live under `.polaris/runs/` | Mutable active worktree pointer and fast local snapshot for the run currently claimed in this checkout. | Preferred fast path, but not sufficient alone | Mutable, atomic replace |
| Telemetry | `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` | Verbose audit/debug trail for lifecycle boundaries, failures, adapter behavior, and diagnostics. | No | Append-only |

### Ledger

The ledger is the durable source for cross-agent resume. It must contain enough compact state to reconstruct or verify the latest known run position without reading chat transcripts, local telemetry, or bootstrap packets. It tracks all Polaris run types in one top-level file with typed events.

Run types:

- `analyze`
- `implement`
- `absorb`
- `docs-ingest`
- `docs-bootstrap`
- `audit`
- `finalize`

### Current State

`current-state.json` remains the active local pointer. It answers "what run is this worktree currently executing?" and lets the common path resume quickly without replaying JSONL. It may be overwritten by a newer run in the same checkout, so it must not be the sole continuation memory.

### Telemetry

Telemetry is detailed operational history. It may include adapter metadata, validation summaries, boundary failures, and debug events. Basic continuation must not require telemetry because remote agents may not have local telemetry files.

---

## 2. Storage Strategy

The global ledger path is:

```text
.polaris/runs/ledger.jsonl
```

Storage decision:

- The ledger is committed and version-controlled.
- The ledger is append-only; existing lines must not be edited, reordered, or deleted.
- Every event is one UTF-8 JSON object followed by `\n`.
- Writers must create `.polaris/runs/` if missing.
- Writers must serialize appends with a repo-local lock when possible.
- Merge conflicts must be resolved by preserving both independently valid JSONL lines in timestamp order when ordering is obvious, or file order with no event loss when ordering is not obvious.

Why this path:

- `.polaris/runs/ledger.jsonl` is repo-local and provider-neutral.
- It survives branch switches, pull requests, cloud agents, and local context resets.
- It is distinct from `.taskchain_artifacts/`, which can contain transient runtime snapshots and verbose artifacts.
- It keeps the global resume index near future per-run `.polaris/runs/<run-id>/` snapshots without mixing it with telemetry.

---

## 3. Event Envelope

Every ledger line must use this base envelope:

```json
{
  "schema_version": 1,
  "event": "run-started",
  "event_id": "01J00000000000000000000000",
  "run_id": "polaris-run-global-run-ledger-2026-05-28-001",
  "run_type": "implement",
  "cluster_id": "POL-151",
  "issue_id": "POL-152",
  "branch": "philmeaux/pol-151-implement-add-global-polaris-run-ledger-for-cross-agent",
  "status": "running",
  "completed_children": [],
  "open_children": ["POL-152", "POL-153"],
  "next_child": "POL-152",
  "last_commit": null,
  "pr_url": null,
  "timestamp": "2026-05-28T03:16:13.194Z"
}
```

Required on every event:

| Field | Type | Requirement |
|---|---|---|
| `schema_version` | integer | Must be `1` for this spec. |
| `event` | string | One of the 11 event names in section 4. |
| `event_id` | string | Globally unique event identifier. ULID is preferred for sortable IDs. |
| `run_id` | string | Stable run identifier. |
| `run_type` | string | One supported run type. |
| `cluster_id` | string or null | Parent cluster issue when applicable. |
| `issue_id` | string or null | Active issue or standalone issue when applicable. |
| `branch` | string | Git branch expected to contain the run artifacts and work. |
| `status` | string | Latest lifecycle status after the event is applied. |
| `completed_children` | string array | Completed child issue IDs after the event is applied. Empty for standalone or pre-child runs. |
| `open_children` | string array | Open child issue IDs after the event is applied. Empty when not applicable or complete. |
| `next_child` | string or null | Next eligible child after the event is applied. |
| `last_commit` | string or null | Latest child/run commit SHA known to the ledger. |
| `pr_url` | string or null | Pull request URL when one exists. |
| `timestamp` | ISO-8601 string | UTC event creation time. |

Optional common fields:

| Field | Type | Purpose |
|---|---|---|
| `parent_run_id` | string | Links an implementation run to an analysis or parent run that spawned it. |
| `related_run_id` | string | Links resumed or superseding run IDs. |
| `worktree` | string | Absolute or repo-relative worktree path when known. |
| `base_branch` | string | Target branch for delivery. |
| `base_sha` | string | SHA used to verify branch drift. |
| `linear_status` | string | Linear state observed at write time. |
| `blocker` | object | Structured blocker details for halted runs. |
| `validation` | object | Compact validation result. |
| `actor` | object | Agent/provider metadata, e.g. `{ "provider": "codex", "mode": "worker" }`. |
| `source` | object | Writer metadata, e.g. `{ "command": "polaris runs resume" }`. |

Consumers must ignore unknown fields.

---

## 4. Event Schema

The ledger defines exactly the 11 POL-147 events below.

### 4.1 `run-started`

Emitted when a new run is bootstrapped and receives a `run_id`.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `running` or `ready` |
| `open_children` | current ordered open children, or empty array |
| `next_child` | first eligible child or null |

### 4.2 `run-resumed`

Emitted when an existing run is selected from `current-state.json` or the ledger and a new session resumes it.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `running` |
| `resume_source` | `current-state`, `ledger`, or `bootstrap` |
| `resume_reason` | human-readable string |

### 4.3 `child-dispatched`

Emitted when a parent/orchestrator dispatches exactly one child to a worker.

Additional required fields:

| Field | Type |
|---|---|
| `issue_id` | active child issue ID |
| `status` | must be `child-dispatched` or `running` |
| `next_child` | must equal `issue_id` |
| `dispatch_epoch` | integer |

### 4.4 `child-completed`

Emitted after a worker return is validated and the child commit is known.

Additional required fields:

| Field | Type |
|---|---|
| `issue_id` | completed child issue ID |
| `status` | must be `running`, `paused`, or `cluster-complete` |
| `last_commit` | non-null git SHA |
| `completed_children` | includes `issue_id` |
| `open_children` | excludes `issue_id` |
| `validation` | compact validation object with `status` |

### 4.5 `run-paused`

Emitted when a run intentionally stops without a blocker, usually due to a one-child session cap, handoff, or operator pause.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `paused` |
| `pause_reason` | string |
| `next_child` | next eligible child or null |

### 4.6 `run-blocked`

Emitted when the run cannot continue until an external unblock condition is satisfied.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `blocked` |
| `blocker` | object with `summary` and `unblock_condition` |

### 4.7 `budget-exhausted`

Emitted when configured context, child, file, or time budget requires a stop.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `paused` |
| `budget` | object with `name`, `value`, and `limit` |
| `next_child` | next eligible child or null |

### 4.8 `cluster-complete`

Emitted when all children for a cluster are complete but delivery/finalize may not have happened yet.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `cluster-complete` |
| `open_children` | must be empty array |
| `next_child` | must be null |

### 4.9 `finalized`

Emitted when final delivery has run and local finalize steps have completed.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `finalized` |
| `finalize_result` | object with compact outcome details |

### 4.10 `pr-created`

Emitted when a pull request exists for the run.

Additional required fields:

| Field | Type |
|---|---|
| `status` | `finalized`, `delivered`, or current lifecycle status |
| `pr_url` | non-null URL |
| `pr_number` | integer or string |

### 4.11 `run-complete`

Emitted when no more work remains for the run lifecycle.

Additional required fields:

| Field | Type |
|---|---|
| `status` | must be `complete` |
| `open_children` | must be empty array |
| `next_child` | must be null |

---

## 5. Resume Lookup Algorithm

The resume lookup algorithm has exactly five steps:

1. **Check current-state.** Read the active worktree `current-state.json`. If it matches the requested issue, cluster, or run and its status is resumable, use it as the fast-path state.
2. **Query ledger.** If current-state is missing, stale, complete, or points to another run, scan `.polaris/runs/ledger.jsonl` for the latest resumable run matching the requested issue, cluster, branch, or run ID.
3. **Bootstrap.** If no matching resumable ledger state exists, create a new run, write `run-started`, and initialize current-state from Linear and git.
4. **Linear check.** Before executing, verify the matched issue/cluster state in Linear. Halt if Linear says the selected child is Done, canceled, blocked by a lower-numbered sibling, or no longer belongs to the parent cluster.
5. **Git check.** Verify the branch exists, the expected commit is reachable when `last_commit` is present, and the worktree is on the ledger branch. Halt or prompt before switching branches or resuming from a divergent history.

Resumable statuses:

- `ready`
- `running`
- `paused`
- `blocked` only after the unblock condition is confirmed resolved
- `child-dispatched` only when the dispatch can be reconciled with current-state, Linear, and git
- `cluster-complete` only for finalize/delivery commands

Terminal statuses:

- `complete`
- `finalized` when the requested command is not delivery inspection
- `canceled`

Ledger replay rule: consumers determine latest state by applying events in file order and keeping the latest event per `run_id`. If two events for the same run have the same timestamp, file order wins.

---

## 6. Conflict Resolution

The ledger may contain multiple open runs. Polaris must prefer deterministic resolution and halt for operator input when continuing automatically could mutate the wrong branch or issue.

### Same cluster, same branch

Use the latest resumable run by ledger order. If both have non-terminal status and different `completed_children`, halt with a reconciliation prompt showing both run IDs.

### Same cluster, different branch

Prefer the run whose branch matches the current git branch. If the requested run ID names a different branch, require explicit branch switch or worktree selection before continuing.

### Different clusters

Current-state may point to another cluster. Do not overwrite it silently. Query the ledger for the requested cluster and either resume that run in a matching branch/worktree or bootstrap a new run only after confirming no open matching run exists.

### Analyze run spawned implement run

Use `parent_run_id` or `related_run_id` to link runs. An `analyze` run with terminal `complete` status is not resumed for implementation work; the implementation run is selected or bootstrapped separately.

### Paused for blocker

A `run-blocked` event remains authoritative until Linear or explicit operator input confirms the unblock condition is resolved. After confirmation, emit `run-resumed` with `resume_source: "ledger"`.

### Finalized run with stale current-state

If current-state points at a finalized or complete run, the ledger terminal event wins. Clear or refresh current-state only through the normal resume/bootstrap path; do not continue child execution.

### Active child conflict

If current-state has `active_child` but the ledger's latest event does not agree, halt. The operator must reconcile whether a worker is still running, a compact return was lost, or state was overwritten.

---

## 7. CLI Command Surface

All commands are under `polaris runs`.

```text
polaris runs list [--open] [--all] [--run-type <type>] [--cluster <issue-id>] [--branch <branch>] [--json]
```

Lists runs reconstructed from the ledger. `--open` shows non-terminal runs only.

```text
polaris runs show <run-id> [--json]
```

Shows the latest reconstructed run state plus the ledger events for one run.

```text
polaris runs resume <issue-or-run-id> [--branch <branch>] [--worktree <path>] [--json]
```

Runs the five-step resume lookup algorithm and either restores current-state for a resumable run or bootstraps a new run.

```text
polaris runs ledger tail [--lines <n>] [--event <event>] [--run-id <run-id>] [--json]
```

Reads recent ledger events without mutating state.

```text
polaris runs reconcile [--issue <issue-id>] [--run-id <run-id>] [--write] [--json]
```

Compares current-state, ledger, Linear, and git. Without `--write`, it is read-only and prints the proposed reconciliation. With `--write`, it may append reconciliation events and refresh current-state after explicit operator approval.

---

## 8. Cross-Agent Handoff Protocol

The ledger is the sole required handoff artifact. A fresh Claude, Codex, Gemini, CI, or future worker session must be able to continue with only:

- the repository checkout,
- `.polaris/runs/ledger.jsonl`,
- access to Linear,
- access to git history/remotes.

Bootstrap packets and telemetry may improve ergonomics, but they are optional. A handoff packet should therefore contain pointers, not unique authority:

```json
{
  "run_id": "polaris-run-global-run-ledger-2026-05-28-001",
  "cluster_id": "POL-151",
  "issue_id": "POL-153",
  "branch": "philmeaux/pol-151-implement-add-global-polaris-run-ledger-for-cross-agent",
  "ledger": ".polaris/runs/ledger.jsonl",
  "next_command": "polaris runs resume POL-151"
}
```

Agent rules:

- Read ledger first when current-state does not match the requested run.
- Do not depend on another agent's transcript.
- Do not require local telemetry for basic continuation.
- Verify Linear before selecting a child.
- Verify git before committing or switching branches.
- Append a ledger event before reporting durable progress.
- Keep worker compact returns small; the ledger records durable state, not reasoning.

---

## 9. Migration Plan

### Phase 1: Add ledger writer alongside current-state

- Create `.polaris/runs/ledger.jsonl`.
- Append `run-started`, `child-dispatched`, `child-completed`, pause/blocker, finalize, PR, and completion events at the same lifecycle points that already update current-state or telemetry.
- Keep existing bootstrap packets unchanged.

### Phase 2: Add read-only ledger commands

- Implement `polaris runs list`, `polaris runs show`, and `polaris runs ledger tail`.
- Validate reconstruction from existing ledger lines in tests.
- Keep resume behavior on current-state while comparing ledger-derived state in diagnostics.

### Phase 3: Add reconcile and resume

- Implement `polaris runs reconcile` as read-only by default.
- Implement `polaris runs resume <issue-or-run-id>` using the five-step algorithm.
- Refresh current-state from the ledger only after Linear and git checks pass.

### Phase 4: Make ledger the cross-agent authority

- Update worker prompts and bootstrap packets to include the ledger path.
- Treat bootstrap packets as convenience artifacts, not required continuation memory.
- Document that a cloud agent can resume from ledger + Linear + git alone.

### Phase 5: Backfill or archive legacy runs

- Optionally generate synthetic ledger events for important existing runs from current-state, telemetry, and PR history.
- Mark synthetic events with `source.synthetic: true`.
- Do not require complete historical backfill before enabling the new model.

---

## 10. Invariants

- The ledger must never lose events during merge conflict resolution.
- A run is not cross-agent resumable until its latest durable position has a ledger event.
- `current-state.json` may be stale; ledger plus Linear plus git decide whether it can be trusted.
- Telemetry is never the only continuation source.
- Multiple open runs are allowed; silent mutation of the wrong run is not.
- Workers execute one child and terminate; they do not select siblings.
- Resume must halt rather than guess when current-state, ledger, Linear, and git disagree.
