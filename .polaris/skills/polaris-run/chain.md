---
name: polaris-run-chain
description: Route map for polaris-run — step order, continuation rules, Polaris runtime integration, and artifact update requirements.
---

# polaris-run chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer cluster scope or progress from conversation context.

## Thin-Parent Orchestration

This skill operates under a **thin-parent** model. The agent running this `chain.md` is an orchestrator, not an implementer.

**Core principles:**
- **The orchestrator does not write code.** All implementation is delegated to workers via `polaris loop dispatch`.
- **The orchestrator does not narrate implementation details.** Its communication should be concise and focused on the orchestration state (dispatching, checkpointing, blocked, complete).
- **The orchestrator does not reason about the repository.** All repository-level cognition belongs to the worker.

### Narration Suppression

To enforce the thin-parent model, the orchestrator's narration is strictly suppressed.

**Allowed narration:**
- Announcing the start of a run.
- Announcing the dispatch of a child.
- Announcing the completion of a child and the next step (continue, finalize, or stop).
- Announcing a blocker.

**Forbidden narration:**
- Summarizing code changes made by a worker.
- Explaining implementation details.
- Speculating on architecture or design.
- Any form of "thinking out loud" about the repository content.

The `polaris loop run` command may provide terse, single-line status updates for headless/SSH execution. The agent should not add any extra narration around these.

## CHECKPOINT gate

**The Foreman must discard worker output except the CompactReturn JSON object.**

When `loop run` exits, the only content the Foreman may retain from the worker subprocess is:
- The final `[POLARIS] COMPLETE <child-id> (commit: <sha>)` signal
- The CompactReturn JSON emitted as the last line of worker stdout

The Foreman must NOT:
- Read, store, or summarize raw worker output or transcripts
- Inspect worker tool-call history
- Ingest implementation details from worker stderr

This gate enforces the thin-parent model: the Foreman is a scheduler, not a consumer of implementation content.

**Preserve the existing step order.** Do not reorder, skip, or merge steps. Each step has a defined entry condition and exit artifact.

## CLI

Always use the repo-local Polaris CLI:

```
npm run polaris -- <command>
```

Never assume a globally linked `polaris` command exists.

## Step traversal order

```text
01-orient-cluster
02-prepare-branch
03-select-child
04-execute-child              ← worker/adapter-owned execution phase
05-validate-child             ← worker-owned validation phase
06-commit-and-update-linear   ← worker-return validation and completion recording
07-decide-continuation   → DISPATCH boundary | CHECKPOINT after worker return | STOP (blocked/all-done) | DELIVER: go to 08
08-closeout-librarian    ← dispatched once per cluster; PR creation blocked until result validated
09-final-delivery        ← reached only after closeout librarian succeeds
```

## CHECKPOINT gate

At each worker return boundary (step 07), apply the CHECKPOINT gate before proceeding:

1. Accept and discard worker output except the CompactReturn JSON object — all other session content is discarded.
2. Parse the CompactReturn JSON. If it is missing or malformed, treat as a blocker and stop.
3. Pass the CompactReturn JSON to `npm run polaris -- loop continue` for state persistence.
4. Preserve the existing step order — do not reorder, skip, or repeat steps based on worker output content.

## Continuation rules

After step 07 evaluates the session:

- **DISPATCH (all remaining children)**: run `npm run polaris -- loop run <cluster-id>`. The runtime dispatches all eligible children serially, enforcing dispatch boundaries internally. The Foreman waits for the subprocess to exit. Progress signals are emitted as `[POLARIS] RUNNING <child-id> (N/M)` and `[POLARIS] COMPLETE <child-id> (commit: <sha>)`. No per-child CompactReturn handling or state repair is needed — the runtime owns that boundary.
- **STOP (blocked)**: halt immediately on blocker. Report unblock condition.
- **STOP (all-done, awaiting delivery)**: `loop run` exits when all children are done. Report branch and last commit. Provide delivery command: `Use polaris-run on <PARENT-ID>. Finalize delivery.`
- **DELIVER**: proceed to step 08 (Closeout Librarian) only when all children are Done and the user explicitly requests delivery in this session invocation.

## Closeout Librarian boundary

**The Closeout Librarian runs exactly once per cluster, between all-children-done and PR creation.**

Step 08 dispatches the Librarian as a bounded session (same model as worker dispatch).
The Foreman waits for the Librarian's sealed result before proceeding to step 09.
PR creation (step 09) is blocked until the Librarian result status is `"success"` or `"partial"`.

**Librarian dispatch message template:**

When dispatching the Closeout Librarian, pass this full message — NOT just the packet path. Replace `<cluster-id>`, `<packet_path>`, `<run_id>`, and `<dispatch_id>` with values from the packet file:

```
You are the Closeout Librarian for cluster <cluster-id>.

Your sealed packet is at: <packet_path>

Read the packet. Follow the closeout-librarian skill chain. Write your sealed result to the path in the packet's `result_path` field. Return only compact JSON: {"role":"closeout-librarian","status":"done","run_id":"<run_id>","cluster_id":"<cluster-id>","dispatch_id":"<dispatch_id>","commit":"<sha>"}.
```

Never dispatch the librarian with only the packet path as the message.

The Foreman must NOT:
- Read the Librarian's session transcript
- Inline the Librarian's work
- Skip step 08 because it appears slow
- Repair the Librarian's output manually
- Run the Librarian after individual workers (cluster-complete only)

## Dispatch boundary enforcement (runtime-owned)

**The runtime enforces dispatch boundaries. Parent/orchestrator inline implementation is forbidden.**

This is not advisory. The runtime will hard-fail with `process.exit(1)` on violations.

`loop run` owns the full dispatch→checkpoint loop internally. The Foreman must not call `loop dispatch` or `loop continue` individually — doing so bypasses the boundary enforcement that `loop run` manages.

### Allowed transition (only legal path)

```
Foreman → npm run polaris -- loop run <cluster-id>
  ↓ (subprocess)
  runtime selects child
  runtime dispatches worker externally
  runtime receives CompactReturn → checkpoints → next child
  runtime emits: [POLARIS] RUNNING <child> (N/M)
  runtime emits: [POLARIS] COMPLETE <child> (commit: <sha>)
  (repeat for each child)
  runtime emits: [POLARIS] COMPLETE (cluster-complete)
  subprocess exits 0
Foreman proceeds to step 07 STOP/DELIVER
```

### Hard failures (illegal transitions)

| Attempt | Runtime response |
|---|---|
| Parent calling `loop dispatch` manually | Bypasses `loop run` — governance violation |
| Parent calling `loop continue` manually | Bypasses `loop run` — governance violation |
| Parent completing child without dispatch record | `exit(1)` + `illegal-state-transition` telemetry event |
| `selected → completed` (no dispatch in path) | Hard failure — never allowed |

**When `execution.providerPolicy.worker.allowNativeSubagent: false` or `execution.providerPolicy.orchestrator.allowNativeSubagent: false`, never use any native subagent or parallel-task mechanism** (applies to all providers: Claude, Codex, Copilot, etc.). `loop run` via `terminal-cli` is the only supported dispatch path.

## Polaris runtime integration

polaris-run uses these Polaris CLI calls:

| Step | Polaris call | Purpose |
|---|---|---|
| 07 | `npm run polaris -- loop run <cluster-id>` | Run all eligible children serially; emits `[POLARIS] RUNNING <child> (N/M)` per child and `[POLARIS] COMPLETE <child> (commit: <sha>)` on completion; exits when cluster-complete or blocked |
| 08 | `npm run polaris -- librarian packet <cluster-id>` | Generate Closeout Librarian packet for the completed cluster |
| 08 | Librarian subagent dispatch | Dispatch Closeout Librarian; wait for sealed result; validate result before proceeding |
| 09 | `npm run polaris -- finalize` | Push branch (including librarian commit), open PR, append JSONL closeout events, archive run snapshot |

`npm run polaris -- loop run <cluster-id>` is the standard execution command. It internally manages the dispatch→checkpoint loop for all children, emitting terse progress signals the Foreman can monitor. The Foreman does not call `loop dispatch` or `loop continue` — those boundaries are owned by `loop run`.

## Context budget

Track in `.taskchain_artifacts/polaris-run/current-state.json` under `context_budget`. Update after each child.

| Counter | Meaning | Stop threshold |
|---------|---------|----------------|
| `children_completed` | Children fully Done this session | `fixed-cap` mode only: ≥ `budget.max_children` from `polaris.config.json` (default 6) → STOP (budget exhausted); no count cap in `run-until-done`/`stop-on-fail` modes; the CLI runtime enforces this |
| `files_touched_total` | Total files changed this session | > 50 → STOP (safety) |
| `last_child_files_touched` | Files changed by last child | > 20 → STOP (safety) |

## Run ID format

Format: `polaris-run-<slug>-<date>-<seq>`
- `<slug>`: 2–4 lowercase hyphenated words from the cluster title. No Linear IDs.
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `polaris-run-loop-boundary-2026-05-23-001`

Resumed sessions generate a new `run_id`. Record the prior in `related_run_id`.

## Telemetry enforcement

Telemetry file: `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Emitted by | Step |
|---|---|---|
| `run-start` | agent | 01 — before any Linear access |
| `child-dispatched` | `npm run polaris -- loop dispatch` | 07 — when one child is accepted by the execution adapter |
| `child-complete` | parent runtime | 07 — after worker return validation and completion recording |
| `loop-checkpoint` | `npm run polaris -- loop continue` | 07 — after each child |
| `analyze-impl-boundary-enforced` | `npm run polaris -- loop continue` | 07 — blocker/state-repair boundary event only |
| `loop-aborted` | `npm run polaris -- loop abort` | any blocker halt |
| `pr-opened` | `npm run polaris -- finalize` | 09 |
| `run-complete` | `npm run polaris -- finalize` | 09 |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Artifact authority

`.taskchain_artifacts/polaris-run/current-state.json` is the sole authoritative live state surface.

- Update only at explicit checkpoint boundaries via `npm run polaris -- loop continue` after worker returns, or when DISPATCH boundaries mandate bootstrapping.
- Parent agents must not update state inline between steps.
- If the checkpoint fails: stop and report the persistence failure.

## Machine snapshot

- **Path**: `.taskchain_artifacts/polaris-run/current-state.json`
- **Update requirement**: only at checkpoint boundaries (via `npm run polaris -- loop continue`)
- **Purpose**: fast agent resume without replaying JSONL or markdown history

## Completion rule

Do not report workflow completion until `.taskchain_artifacts/polaris-run/current-state.json` has `status: complete`.

## Linked-skill invocation boundaries

| Skill | Allowed steps | Condition |
|---|---|---|
| repo-analysis | 01, 02, 03, 04 | targeted lookup only; conditional on provider availability |
| execution-adapter | 07 | required when a completed child has a next open child |

## Execution reporting

At checkpoint boundaries (worker returns), emit a checkpoint report:

```text
**[step-name]** done | blocked | needs-input
Changed: <files / artifacts / branches / issues> or none
Validated: <commands / checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full:
- Generated code
- Safety warnings
- Blocker descriptions
- Acceptance-criteria gap explanations
- Irreversible-action confirmations
