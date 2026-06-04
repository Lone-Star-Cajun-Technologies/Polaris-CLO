<!-- polaris:doctrine-candidate -->
# Polaris Compact Contracts

Authoritative specification for orchestrator and worker compact behavior, boundary rules, durable state, configurable levels, bootstrap enforcement, and provider compatibility.

---

## 1. Orchestrator Compact Contract

The orchestrator is the parent loop (polaris-run or polaris-analyze) that manages cluster state across child dispatches.

### What the orchestrator tracks

| Field | Location | Notes |
|---|---|---|
| Completed children | `current-state.json → completed_children[]` | Append-only |
| Open children | `current-state.json → open_children[]` | Popped as each child is dispatched |
| Active child | `current-state.json → active_child` | Set at dispatch, cleared at return |
| Stop / continue / finalize state | `current-state.json → status` | `ready`, `executing`, `cluster-complete`, `all-children-complete` |
| Next child | `current-state.json → next_open_child` | Set by step 03 and step 07 |
| Validation / failure state | `current-state.json → validation_status` | `passed`, `failed`, or absent |
| Budget / cap | `current-state.json → context_budget` | `children_completed`, `files_touched_total`, `last_child_files_touched` |
| Last commit | `current-state.json → last_commit` | 7-char SHA of the child's commit |
| Run metadata | `current-state.json → run_id`, `cluster_id`, `branch`, `pr_url` | Immutable per run |

### What the orchestrator must NOT accumulate

- Child diffs or file-level patch content
- Worker transcript or reasoning logs
- Full test output beyond pass/fail summary
- Full Linear issue body for children beyond the active child
- Implementation details of completed children
- Large log buffers from validation commands

The orchestrator receives a compact summary only. The `dispatch_contract.parent_receives_compact_summary_only: true` invariant in `ExecutionAdapterContract` enforces this at the adapter layer.

---

## 2. Worker Compact Contract

Each worker executes exactly one child issue and terminates.

### Rules

1. **One child per worker.** Workers MUST NOT select or execute the next child after completing their assigned child.
2. **Minimal structured output.** Workers write exactly one JSON line (a `CompactReturn`) as the last line of stdout before exiting. No conversational narration, no multi-line prose after the JSON.
3. **No cross-child state carry.** Workers do not read prior workers' transcripts or maintain conversational context across child boundaries.
4. **Durable-state-first.** All significant outputs (commits, telemetry, state updates) are written to files before the compact return is emitted. The compact return summarizes what was persisted, not what exists only in chat context.
5. **Terminate after one child.** Workers MUST exit immediately after emitting the compact return JSON. The lifecycle contract `terminate_after_completion: true` makes this explicit.
6. **No unilateral scope expansion.** If a discovery requires changes outside the child's `allowed_scope`, the worker notes it as a follow-up in the compact return and does not silently expand scope.

### Worker session boundary

```
START: receive WorkerPacket (pre-compiled instructions + lifecycle contract)
  → execute assigned child (implement, commit, update state, append telemetry)
  → run validation commands
  → emit CompactReturn JSON to stdout
END: terminate immediately
```

The worker's full transcript is retained by the worker's execution context (agent session log, CI log, etc.) and is NOT forwarded to the orchestrator.

---

## 3. CompactReturn Field Definitions

Source: `src/loop/compact-return.ts`

| Field | Type | Values | Purpose |
|---|---|---|---|
| `child_id` | `string` | Linear child ID (e.g. `POL-115`) | Identifies which child was executed |
| `status` | `'done' \| 'failed' \| 'blocked'` | — | Execution outcome |
| `commit` | `string \| null` | 7-char git SHA, or `null` | Commit produced during this child |
| `validation` | `'passed' \| 'failed' \| 'skipped'` | — | Result of child-level validation |
| `tracker_updated` | `boolean` | — | Whether Linear status was updated to Done |
| `state_updated` | `boolean` | — | Whether `current-state.json` was updated before exit |
| `telemetry_updated` | `boolean` | — | Whether a JSONL event was appended before exit |
| `next_recommended_action` | `'continue' \| 'stop' \| 'investigate'` | — | Guidance for the orchestrator |

### Gaps / notes

- `tracker_updated`, `state_updated`, and `telemetry_updated` are present in `CompactReturn` but are not required by the `IMPL_RETURN_CONTRACT` list in `worker-packet.ts` (which lists `child_id`, `status`, `commit`, `validation`, `next_recommended_action` only). Workers implementing the full interface SHOULD emit all fields; the orchestrator MUST NOT fail if the three boolean fields are absent when reading a compact return that only satisfies `IMPL_RETURN_CONTRACT`.
- No `compact_level` field is currently present on `CompactReturn`. When configurable levels are implemented (see §6), a `compact_level` field SHOULD be added as an optional string so the orchestrator can log which level was in effect.

---

## 4. Boundary Rules

These rules govern what data may cross the worker→orchestrator boundary.

### Permitted

| Data | Format | Notes |
|---|---|---|
| `CompactReturn` JSON | Single JSON line on stdout | Mandatory |
| `current-state.json` updated fields | File on disk | Worker writes; orchestrator reads |
| Telemetry JSONL event | Appended line in run JSONL | Worker appends; orchestrator reads on resume |
| Git commit SHA | Part of `CompactReturn.commit` | Identifies the commit artifact |
| Pass/fail status | Part of `CompactReturn.validation` | Not full test output |
| Next recommended action | Part of `CompactReturn.next_recommended_action` | One of three values |

### Forbidden

| Data | Why forbidden |
|---|---|
| Child transcript / reasoning | Orchestrator accumulates unbounded context |
| Full test output | Non-compact; irrelevant after pass/fail is known |
| File diffs or patch content | Implementation detail not needed by orchestrator |
| Full Linear issue body | Already fetched in step 01; re-injecting wastes budget |
| Intermediate validation logs | Not durable; not actionable |
| Error tracebacks longer than one line | Include in `current-state.json` field at most |

---

## 5. Durable State Rules

All state that must survive a context reset or session restart MUST be written to files, not retained only in chat context.

| Artifact | Path | Who writes | When |
|---|---|---|---|
| Run ledger | `.taskchain_artifacts/polaris-run/current-state.json` | Orchestrator and worker | After every step, before advancing |
| Telemetry | `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` | Orchestrator and worker | After each event |
| Spec and documentation | `docs/spec/` | Worker | As deliverable of the child |
| Validation artifacts | Wherever the child specifies | Worker | Before compact return |
| Bootstrap packet | `.polaris/bootstrap/<run-id>-<timestamp>.json` | `polaris loop continue` | At each checkpoint |
| Map index | `.polaris/map/` | `polaris map update --changed` | After each commit |

### Immutability rule

The telemetry JSONL is append-only. Existing events MUST NOT be modified or deleted. The `current-state.json` is the mutable ledger; the JSONL is the audit log.

### Persistence failure rule

If a write to `current-state.json` or the telemetry JSONL fails, the workflow MUST halt and report the persistence failure. A step is not considered complete until its state update is persisted.

---

## 6. Configurable Compact Levels

Compact behavior is configurable via `PolarisConfig.compact.level`. Three levels are defined:

### Level: `standard` (default)

- Worker emits full `CompactReturn` (all fields).
- Orchestrator receives compact return plus artifact pointer diffs from `current-state.json`.
- Telemetry captures all events.
- Suitable for most clusters; balances verbosity and debuggability.

### Level: `strict`

- Worker emits minimal `CompactReturn` (only `IMPL_RETURN_CONTRACT` fields: `child_id`, `status`, `commit`, `validation`, `next_recommended_action`).
- Orchestrator receives no additional context from worker beyond compact JSON and file state.
- Bootstrap packet omits resume instructions beyond the pointer to `current-state.json`.
- Telemetry captures all events (telemetry is always durable regardless of level).
- Use when context budget is critically constrained or worker transcripts are known to be large.

### Level: `minimal`

- Same as `strict`, plus:
- Worker suppresses all stdout except the final `CompactReturn` JSON line.
- No informational log lines from `polaris map update` or `polaris loop continue` flow back to orchestrator.
- Orchestrator reads state entirely from `current-state.json` and telemetry JSONL.
- Use for fully automated CI pipelines or environments where any non-JSON stdout is disruptive.

### What each level controls

| Behavior | `standard` | `strict` | `minimal` |
|---|---|---|---|
| Full `CompactReturn` fields | yes | no (IMPL_RETURN_CONTRACT only) | no |
| Resume instructions in bootstrap | yes | no | no |
| Informational stdout from tools | yes | yes | no |
| Telemetry | always | always | always |
| Map update output to orchestrator | yes | yes | no |

---

## 7. Bootstrap Enforcement

Compact behavior is injected at three points in the dispatch pipeline.

### 7.1 Config-driven (`PolarisConfig.compact`)

`polaris.config.json` carries a `compact` section (added by POL-116) that declares `orchestrator_mode`, `worker_mode`, and `level`. This is the source of truth for compact settings in a given repo.

### 7.2 Bootstrap packet (`buildBootstrapPacket`)

`src/loop/bootstrap-packet.ts` calls `buildCompactBootstrapState()` (from `execution-adapter.ts`) and embeds the result as `compact_bootstrap_state` inside the `ExecutionAdapterContract`. The contract is attached to the bootstrap packet at dispatch time.

`CompactBootstrapState` carries:
- `run_id`, `cluster_id`, `child_id` — identity
- `state_file`, `telemetry_file` — durable artifact pointers
- `current_state_sha` — integrity check
- `branch` — git scope
- `return_summary_contract` — the field list the worker must include

The adapter receives this compact state and uses it to construct the worker's initial prompt or dispatch configuration. Workers never receive the full orchestrator state — only the fields enumerated in `CompactBootstrapState`.

### 7.3 Skill instructions (`.polaris/skills/polaris-run/`)

Skill chain steps enforce compact behavior through scope declarations (`allowed_files`, `stop_rules`) and the chain's continuation rules. The `04-execute-child` step forbids cross-child state carry and out-of-scope file modifications. The `07-decide-continuation` step enforces the one-child-per-session adapter handoff rule.

Caveman (external) and polaris-native compact instructions both operate at this layer. Polaris-native compact is the required baseline (see §8).

---

## 8. Provider Compatibility

### Polaris-native compact (required baseline)

Polaris-native compact behavior is fully self-contained in:
- `src/loop/compact-return.ts` — `CompactReturn` interface and validator
- `src/loop/execution-adapter.ts` — `CompactBootstrapState`, `ExecutionAdapterContract`
- `src/loop/bootstrap-packet.ts` — packet assembly
- `.polaris/skills/polaris-run/` — skill-level enforcement

No external provider is required. Polaris MUST function fully without any detected provider.

### Caveman (optional enhancement)

Caveman reduces orchestrator context accumulation by compressing step-level summaries into terse checkpoints. When Caveman is installed:
- Step 01 (`orient-cluster`) activates `caveman-full` for terse orientation output.
- Checkpoint emissions throughout the run are compressed by Caveman.

When Caveman is not installed:
- Polaris falls back to its own compact contracts at all levels.
- There is no functional gap — verbosity may be higher, but correctness is identical.

Caveman is **optional**. The hard dependency (mandatory halt if Caveman not installed) is removed by POL-117.

### GitNexus (optional enhancement)

GitNexus provides alternative repo-analysis and compaction services. When detected:
- `polaris init` writes a `providers.compactionProviders` entry to `polaris.config.json`.
- `buildCompactBootstrapState` may reference the provider entry for enhanced state injection.

When GitNexus is not installed: identical fallback to Polaris-native compact.

### Future providers

Provider detection is opt-in and additive. Any future provider MUST:
1. Implement the same `CompactReturn` interface.
2. Respect `current-state.json` as the authoritative state surface.
3. Write to telemetry JSONL in append-only mode.
4. Not require changes to `CompactBootstrapState` or `ExecutionAdapterContract` fields.

Provider-neutral default behavior (Polaris-native) is the invariant baseline. Provider enhancements are additive only.
