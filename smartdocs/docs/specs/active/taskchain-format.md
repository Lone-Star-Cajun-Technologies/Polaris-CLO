---
kind: spec
status: active
implements: 
related: smartdocs/docs/specs/active/taskchain-authoring.md
supersedes: 
superseded_by: 
depends_on: 
validates: 
source_paths: 
---

# Native Polaris Taskchain Format

## Purpose

A native Polaris taskchain describes **what** a cluster must accomplish — its children, their types, and their dependencies. It delegates **how** to the `polaris` CLI: `polaris loop continue`, `polaris loop resume`, and `polaris finalize` handle orchestration mechanics.

A taskchain is significantly shorter than EVO skill chains because the mechanics (checkpoint, boundary enforcement, delivery) are encapsulated in the CLI.

---

## File location

Each skill has its own directory under `.codex/skills/`:

```
.codex/skills/<skill-name>/chain.yaml    # machine-readable taskchain
.codex/skills/<skill-name>/README.md     # human-readable description (optional)
```

---

## Schema

```yaml
# polaris-taskchain: chain.yaml
version: "1.0"
cluster_id: "<LINEAR-PARENT-ID>"
linear_parent: "<LINEAR-PARENT-ID>"

children:
  - id: "<LINEAR-CHILD-ID>"
    title: "<child title>"
    session_type: analyze | implement
    blockedBy: []              # list of sibling child IDs; [] means no blockers

loop:
  max_children_per_session: 3
  analyzeImplBoundaryEnforced: true

finalize:
  target: <repo-slug>          # e.g. "polaris" or "git-fit"
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | yes | Format version. Always `"1.0"`. |
| `cluster_id` | string | yes | Linear ID of the parent cluster issue (e.g. `"POL-7"`). |
| `linear_parent` | string | yes | Same as `cluster_id`. Explicit for tooling that reads only this field. |
| `children` | list | yes | Ordered list of child issues. Execution follows list order, subject to `blockedBy`. |
| `children[].id` | string | yes | Linear ID of the child issue (e.g. `"POL-31"`). |
| `children[].title` | string | yes | Child title, matching the Linear issue title. |
| `children[].session_type` | enum | yes | `analyze` for read/design work; `implement` for code changes. |
| `children[].blockedBy` | list | yes | Sibling child IDs that must be Done before this child can start. Use `[]` if none. |
| `loop.max_children_per_session` | int | yes | Stop threshold: halt session after this many children complete. Default `3`. |
| `loop.analyzeImplBoundaryEnforced` | bool | yes | If `true`, `polaris loop continue` halts when an analyze session would advance into an implement child. |
| `finalize.target` | string | yes | Slug of the target repo for delivery. Passed to `polaris finalize` to select the push/PR target. |

---

## Session types

Each child declares one of two session types:

- **`analyze`** — read-only or design work: writing specs, reviewing architecture, producing output that feeds implementation. No production code changes.
- **`implement`** — code changes: adding/modifying source files, tests, and config.

When `analyzeImplBoundaryEnforced: true`, a session that starts in `analyze` mode will not auto-continue into the first `implement` child. `polaris loop continue` emits a boundary enforcement event and halts, requiring a fresh session with explicit `implement` scope.

---

## Execution flow

1. **Session start** — agent reads `chain.yaml`, initializes `current-state.json` under `.polaris/runs/`, and sets `session_type` from the first child's type.
2. **Child loop** — for each child:
   - Execute the child per its scope (from the Linear issue).
   - Commit: `[<CHILD-ID>] <child title>`.
   - Run `polaris loop continue` — updates state, emits bootstrap packet, checks boundary.
3. **Session stop** — halt when `children_completed >= max_children_per_session`, boundary is triggered, a blocker is encountered, or all children are Done.
4. **Delivery** — when cluster is complete, run `polaris finalize` to push, open PR, and archive the run snapshot.
5. **Resume** — if a session was stopped mid-cluster, run `polaris loop resume` to re-enter from the checkpoint.

---

## Mapping to LoopState

`chain.yaml` is the static declaration. At runtime, the agent initializes `current-state.json` from it:

| `chain.yaml` field | `LoopState` field |
|--------------------|-------------------|
| `cluster_id` | `cluster_id` |
| `children[].id` (ordered, open) | `open_children` |
| `children[].session_type` | `open_children_meta[id].type` |
| `loop.max_children_per_session` | `context_budget.max_children_per_session` |
| first child's `session_type` | `session_type` |

`polaris loop continue` reads and updates `LoopState` — it does not read `chain.yaml` directly.

---

## Complete example: POL-7 (Cluster 6)

```yaml
# polaris-taskchain: chain.yaml
version: "1.0"
cluster_id: "POL-7"
linear_parent: "POL-7"

children:
  - id: "POL-31"
    title: "[C6.1] Design native Polaris taskchain format and chain specification"
    session_type: analyze
    blockedBy: []

  - id: "POL-32"
    title: "[C6.2] Implement polaris-run native taskchain skill"
    session_type: implement
    blockedBy: ["POL-31"]

  - id: "POL-33"
    title: "[C6.3] Implement polaris-analyze native taskchain skill with analyze→impl boundary"
    session_type: implement
    blockedBy: ["POL-31"]

  - id: "POL-34"
    title: "[C6.4] Remove temporary EVO bootstrap scaffolding from Polaris repo"
    session_type: implement
    blockedBy: ["POL-32", "POL-33"]

  - id: "POL-35"
    title: "[C6.5] Document Polaris taskchain authoring guide"
    session_type: implement
    blockedBy: ["POL-32", "POL-33"]

loop:
  max_children_per_session: 3
  analyzeImplBoundaryEnforced: true

finalize:
  target: polaris
```

---

## What this format is NOT

- Not a runbook. Runbooks belong in `README.md`, not `chain.yaml`.
- Not EVO's `chain.md`. EVO chains embed soft rules and governance in prose. Polaris chains are declarative YAML — all mechanics are in the CLI.
- Not agent-specific. `chain.yaml` contains no Claude-, Codex-, or Gemini-specific framing.
