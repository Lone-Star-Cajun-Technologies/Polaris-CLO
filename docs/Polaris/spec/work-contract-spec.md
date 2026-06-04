# Work Contract Specification

> Canonical reference for the Polaris Work Contract architecture.
> Covers intake normalization, execution flow, trackerless vs. tracker-backed modes,
> and evidence/closeout semantics.

---

## 1. WorkContract — Normalized Interface

The `WorkContract` type is the single normalized representation of a unit of work
inside Polaris, regardless of where that work originated. Every intake source
(Linear tracker, local spec file, CLI prompt) is translated into a `WorkContract`
before entering the execution pipeline.

### Type definition

```typescript
// src/types/work-contract.ts

export type WorkSourceType = "linear" | "local";

export interface WorkSource {
  type: WorkSourceType;   // Origin adapter
  id:   string;           // Stable identifier in the source system
  path: string;           // Filesystem path or empty string when not applicable
  url:  string;           // HTTP URL or empty string when not applicable
}

export interface WorkContract {
  source:               WorkSource;      // Where the work came from
  objective:            string;          // Plain-text goal statement
  acceptance_criteria:  string[];        // Ordered list of pass/fail criteria
  allowed_scope:        string[];        // File/path constraints for the worker
  validation_commands:  string[];        // Shell commands that must succeed
  linked_docs:          string[];        // Canonical docs referenced by this work
  evidence_requirements: string[];       // Required evidence fields before close
  children:             WorkContract[];  // Nested sub-tasks (recursively typed)
}
```

### Field semantics

| Field | Required | Semantics |
|---|---|---|
| `source` | ✅ | Identifies the canonical origin of this work unit. Used for deduplication and for closing the issue in a tracker-backed run. |
| `objective` | ✅ | Human-readable goal. Written directly into worker prompts and spec documents. |
| `acceptance_criteria` | ✅ | Ordered boolean conditions. A worker must satisfy all criteria before the issue can be closed. |
| `allowed_scope` | ✅ | Glob patterns or explicit file paths the worker is permitted to touch. Used to generate the `allowed_scope` field in sealed worker packets. |
| `validation_commands` | ✅ | Shell commands run after implementation. All must exit 0. |
| `linked_docs` | ✗ | Informational references; not enforced at runtime. |
| `evidence_requirements` | ✗ | Named evidence fields the worker must supply (e.g. `"commit"`, `"test_output"`). Enforced during finalize. |
| `children` | ✗ | Sub-tasks. Each child is itself a `WorkContract`. Polaris flattens the tree into an ordered `open_children` list at bootstrap time. |

---

## 2. Intake Source Mapping

Each supported intake source maps its native representation into a `WorkContract`.

### 2a. Linear tracker adapter

**Source type:** `"linear"`

| Linear field | WorkContract field |
|---|---|
| `issue.identifier` | `source.id` |
| `issue.url` | `source.url` |
| `issue.title` | `objective` |
| Parsed `## Acceptance Criteria` section | `acceptance_criteria` |
| Parsed `## Scope` section | `allowed_scope` |
| Parsed `## Validation` section | `validation_commands` |
| Parsed `## Children` / sub-issues | `children` |

The Linear adapter reads the issue body as Markdown and extracts sections using
the same `parseSections` helper as the spec adapter. Tracker-specific mutations
(state changes, comments, labels) are dispatched through `TrackerAdapter.syncOut()`.

### 2b. Spec file adapter (`SpecAdapter`)

**Source type:** `"local"` (as `"spec"` in the `ExecutionGraphV2.source.type` field)

The spec adapter (`src/tracker/adapters/spec/index.ts`) accepts a Markdown file with
the following recognized sections:

| Markdown section | WorkContract field |
|---|---|
| `## Objective` | `objective` |
| `## Scope` / `## Files` | `allowed_scope` |
| `## Validation` | `validation_commands` |
| `## Children` (bullet list) | `children[*].objective` |

Child `WorkContract`s are synthesized from each bullet item under `## Children`.
Each child inherits the parent's `allowed_scope` and `validation_commands`.

The cluster ID is derived from the spec filename:
`spec-<slugified-basename>` (e.g. `my-feature.md` → `spec-my-feature`).

Child IDs are positionally assigned: `spec-child-01`, `spec-child-02`, …

### 2c. CLI prompt source

> **Out of scope for this cluster.** CLI prompt intake is a future intake path.
> When implemented it will produce a `WorkContract` with `source.type = "local"`
> and an auto-generated `source.id`.

---

## 3. Execution Flow

```
Intake source
    │
    ▼
[Adapter].syncIn()          ← reads source, produces LocalGraph (ExecutionGraphV2)
    │
    ▼
LocalGraph
    │
    ▼
runLoopBootstrapInit()      ← writes current-state.json + RunBootstrapSeal
    │
    ▼
polaris loop dispatch       ← selects next child, seals worker packet
    │
    ▼
Worker session              ← implements child, commits, writes result JSON
    │
    ▼
polaris loop continue       ← reads result, advances state
    │
    ▼
[all children complete?]
    │  yes
    ▼
runFinalize()               ← closes issues (tracker) or no-ops (trackerless)
```

### Step details

**`syncIn()` (adapter):**
Reads the intake source and produces an `ExecutionGraphV2` wrapped in a `LocalGraph`.
The graph contains: one root node (the cluster), one child node per task, and a
`clusters` map with `activeCluster` pointing to the root.

**`runLoopBootstrapInit()`:**
Writes `current-state.json` with a `RunBootstrapSeal`. The seal cryptographically
binds the run ID, cluster ID, and initial child list. Dispatch is refused without a
valid seal.

**`polaris loop dispatch`:**
Reads `current-state.json`, verifies the seal, selects the next open child, seals
a worker packet, and updates the state to `active_child`.

**Worker session:**
Receives the sealed packet. Implements the assigned child within `allowed_scope`.
Runs `validation_commands`. Commits. Writes a compact result JSON to
`result_file`.

**`polaris loop continue`:**
Reads the result JSON. Moves the child from `open_children` to
`completed_children`. Advances `step_cursor`. If no open children remain, triggers
finalize.

**`runFinalize()`:**
In tracker-backed mode: closes tracker issues, updates labels, posts comments.
In trackerless mode: no-op — all evidence is local (commits, result files).

---

## 4. Trackerless vs. Tracker-Backed Modes

### Tracker-backed mode

- `PolarisConfig.tracker.adapter` is set to `"linear"` or `"mcp-bridge"`.
- `syncIn()` pulls issues and children from the tracker API.
- `syncOut()` pushes state changes (close, comment, label) back to the tracker.
- `runFinalize()` closes the parent issue and all completed children.
- Evidence (commit SHA, test output) is posted as issue comments.

### Trackerless mode

- `PolarisConfig.tracker.adapter` is set to `"local"`, `"spec"`, or is absent.
- Work is defined entirely in local files (spec Markdown or `clusters.json`).
- No tracker API calls are made at any point in the lifecycle.
- `runFinalize()` detects the absent adapter and skips all tracker mutations cleanly.
- Evidence lives in `.polaris/clusters/<id>/results/` and git history.

### Behavioural differences

| Concern | Tracker-backed | Trackerless |
|---|---|---|
| Work source | Tracker API | Local Markdown spec |
| Child IDs | Issue identifiers (`POL-123`) | `spec-child-NN` |
| Finalize | Closes tracker issues | No-op |
| Evidence delivery | Issue comments + labels | Result JSON files |
| Deduplication | Tracker enforces | Consumer responsibility |

---

## 5. Evidence, Commits, Validation, and Closeout Without a Tracker

### Evidence

Evidence is the structured record a worker produces to prove it satisfied the
acceptance criteria. In trackerless mode the evidence lives exclusively in the
sealed result JSON at:

```
.polaris/clusters/<cluster-id>/results/<child-id>-<dispatch-id>.json
```

Required fields (from `WorkContract.evidence_requirements`):

| Field | Description |
|---|---|
| `commit` | Git SHA of the commit containing the implementation |
| `validation` | Object with `passed: true` or an array of passing test names |
| `status` | `"done"` \| `"success"` to signal successful completion |

### Commits

Workers are required to create exactly one git commit per child. The commit SHA is
recorded in the result JSON and in the loop state under
`completed_children_results.<child-id>.commit`.

In trackerless mode there is no tracker to close, so the commit is the canonical
proof of delivery. `git log --oneline` is the audit trail.

### Validation

Validation commands come from `WorkContract.validation_commands`. All must exit 0.
The worker runs them after implementation and records the result in the result JSON.
`polaris loop continue` does not re-run validation; it trusts the worker's evidence.

### Closeout

In trackerless mode "closeout" means:

1. Worker writes result JSON with `status: "done"` and `validation.passed: true`.
2. `polaris loop continue` reads the result, moves the child to `completed_children`.
3. When all children are complete, `runFinalize()` is called but performs no tracker
   mutations — it simply marks the run as complete in the state file.
4. The final `current-state.json` with `status: "completed"` and all children in
   `completed_children` is the canonical end-of-run record.

---

## 6. Extension Points

| Concern | Extension mechanism |
|---|---|
| New intake source | Implement `TrackerAdapter` interface; register in adapter registry |
| Custom evidence fields | Add to `WorkContract.evidence_requirements`; enforce in finalize |
| Custom validation | Add commands to `WorkContract.validation_commands` |
| Child ordering | Specify `dependencies` in `ExecutionGraphV2`; dispatcher respects DAG order |

---

## 7. Related Files

| Path | Role |
|---|---|
| `src/types/work-contract.ts` | `WorkContract` and `WorkSource` type definitions |
| `src/tracker/adapters/spec/index.ts` | `SpecAdapter` — spec file intake |
| `src/tracker/adapters/linear/` | Linear tracker intake/output adapter |
| `src/tracker/local-graph.ts` | `LocalGraph` — wrapper around `ExecutionGraphV2` |
| `src/tracker/schema.ts` | Zod schema for `ExecutionGraphV2` |
| `src/loop/run-bootstrap.ts` | `runLoopBootstrapInit`, `RunBootstrapSeal` |
| `src/loop/dispatch.ts` | Child selection and packet sealing |
| `src/loop/lifecycle.ts` | `runFinalize` and end-of-run handling |
| `src/cluster-state/store.ts` | Cluster state persistence |
