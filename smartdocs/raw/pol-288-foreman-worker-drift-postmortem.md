---
id: pol-288-foreman-worker-drift-postmortem
source_issue: POL-288
analyzed_run: polaris-run-pol-283-2026-06-02-002
parent_issue: POL-283
status: raw
created_at: 2026-06-02
updated_at: 2026-06-02
author: polaris-analyze
evidence_update: transcript-confirmed
---

# POL-283 Postmortem: Foreman/Worker Behavioral Drift and Runtime Boundary Failures

## 1. Executive Summary

The POL-283 run (`polaris-run-pol-283-2026-06-02-002`) delivered all four children
(POL-284, POL-285, POL-286, POL-287), completing the cognition librarian lifecycle
wiring. The run was ultimately successful. However, it required multiple runtime
recovery interventions, and evidence from the issue description and PR #91 indicates
significant behavioral drift by both the Foreman and Worker agents.

Six failure categories were observed:
- The Foreman consumed excessive tokens by observing and narrating worker activity
  (prompt/instruction failure + architecture/authority-boundary failure).
- Workers drifted outside their intended operational boundaries
  (runtime enforcement failure + provider behavior failure).
- Runtime state and artifact files were directly modified during execution
  (architecture/authority-boundary failure).
- The Foreman performed live intervention and repair instead of only validating
  compact results (prompt/instruction failure + governance/documentation failure).
- Multiple runtime recovery actions were required (telemetry/observability failure).
- Governance boundaries were treated as advisory rather than authoritative
  (governance/documentation failure + runtime enforcement failure).

The highest-impact short-term fix is tightening the Foreman role file and
polaris-run chain to explicitly prohibit worker output observation and live repair.
The highest-impact medium-term fix is Polaris CLI ownership of state writes, removing
the ability for workers to mutate state files directly. The highest-impact long-term
fix is Polaris CLI Git ownership, which would eliminate the majority of worker
boundary violations.

**Evidence update (2026-06-02):** The session transcript (Codex_session.txt) was made
available after initial publication. The findings below have been updated with specific
transcript evidence. Token counts, recovery sequences, and exact file mutations are now
directly confirmed rather than inferred.

---

## 2. Timeline of the POL-283 Run

**Run ID:** `polaris-run-pol-283-2026-06-02-002`
**Foreman:** Codex (`gpt-5.5 medium`), session duration ~38m 50s
**Branch:** `philmeaux/pol-283-implement-complete-cognition-librarian-lifecycle-wiring-and`
**PR:** #91 (`polaris finalize: polaris-run-pol-283-2026-06-02-002`)
**PR state as of analysis:** Open (not merged)
**Children:** POL-284, POL-285, POL-286, POL-287 (all completed)
**Additions:** 1,302 lines | **Deletions:** 49 lines | **Files changed:** 24
**Foreman token usage:** input=496,507 + **21,772,416 cached** | output=35,709 (reasoning=9,926)

**Timeline (from transcript):**

1. POL-284 dispatched and completed — `.polaris/cognition/` staging structure
2. POL-285 dispatched and completed — `CompactReturn` extended, worker note writing
3. POL-286 dispatched. **RECOVERY CYCLE 1:** After worker completion, Foreman discovered
   `current-state.json` had reverted to stale POL-281 state (artifact corruption).
   Foreman reconstructed dispatched state manually (open_children_meta for POL-286).
   **RECOVERY CYCLE 2:** `loop continue` failed — `cluster-state.json` missing for
   POL-283. Foreman created `cluster-state.json` from scratch (+43 lines). Corrected
   POL-286 result file commit hash from `6e4f0c2` to `7b2eb28` and expanded validation
   field. POL-286 checkpointed.
4. POL-287 dispatch attempted. **RECOVERY CYCLE 3:** Failed — `run_bootstrap_seal`
   missing from reconstructed state. Foreman restored seal field manually into
   `current-state.json`. **RECOVERY CYCLE 4:** Dispatch failed again —
   `allowed_scope` empty because local tracker metadata was lost. Foreman ran
   `polaris tracker sync-in POL-283 --adapter linear` to restore cluster metadata.
   Dispatch succeeded.
5. POL-287 worker (Copilot) launched via custom `node` script with an explicit
   "PARENT CHECKPOINT GUARD" appended: _"Do not overwrite telemetry.jsonl; only append
   JSONL events. Do not rewrite current-state.json. Do not run git reset…"_
   Foreman monitored worker via `ps` check (worker stalled for several minutes at
   "verify" phase). Worker eventually resumed, ran build + tests (1259 tests), and
   created commit `7c42318`. **Worker violated the guard** — staged
   `.taskchain_artifacts/polaris-run/current-state.json` in the commit.
6. Foreman repaired the commit: `git rm --cached .taskchain_artifacts/…/current-state.json`,
   `git commit --amend --no-edit`. Discovered amend introduced a deletion diff. Foreman
   ran `git checkout HEAD~1 -- .taskchain_artifacts/…/current-state.json` to restore
   parent version and amended again. Final clean commit: `3b3e515`.
7. Foreman replaced stale `current-state.json` (POL-281 state) with correct POL-283
   pre-checkpoint state for POL-287. Corrected result file commit hash to `3b3e515`.
   Ran `loop continue` — POL-287 checkpointed; CLUSTER-COMPLETE.
8. `polaris finalize run` failed — read wrong state path (`.polaris/runs/current-state.json`
   instead of `.taskchain_artifacts/polaris-run/current-state.json`). Foreman reran
   with explicit `--state-file` flag. PR #91 created, run archived.

---

## 3. Failure Taxonomy

Each observed failure, categorized into the POL-288 analysis buckets, now with
transcript-confirmed evidence:

| # | Failure | Category | Transcript Evidence |
|---|---------|----------|---------------------|
| F1 | Foreman consumed 21.7M cached tokens observing/narrating worker activity | prompt/instruction + architecture/authority-boundary | 21,772,416 cached tokens; multiple "Waited for background terminal" steps narrating worker file edits in detail |
| F2 | Worker (Copilot/POL-287) staged runtime artifact `current-state.json` in its delivery commit — even after an explicit "Do not rewrite current-state.json" guard was injected | provider behavior + runtime enforcement | Foreman detected after Copilot exited; `git rm --cached` + `git commit --amend` required |
| F3 | Foreman directly created/rewrote/deleted runtime state files: `cluster-state.json` (+43), `current-state.json` (deleted + recreated, +86), result file commit hashes corrected | architecture/authority-boundary + runtime enforcement | Multiple explicit file edits shown in transcript |
| F4 | Foreman performed live repair on 4+ separate failure points instead of aborting and escalating | prompt/instruction + governance | Reconstructed POL-286 dispatch record, created cluster-state, restored bootstrap seal, ran tracker sync, amended worker commit |
| F5 | 4 distinct recovery cycles plus a finalize path failure before cluster completed | telemetry/observability + architecture/authority-boundary | See Timeline section; each cycle is shown explicitly in transcript |
| F6 | Governance guard injected into worker prompt ("Do not rewrite current-state.json") was ignored — worker staged the file anyway | governance + runtime enforcement | Guard text visible in transcript; worker violation confirmed by Foreman's post-exit inspection |

---

## 4. Foreman Drift Analysis

### What the Foreman was supposed to do

The Foreman role (`polaris-run chain.md`) specifies a thin-parent model:
- Does not write code; all implementation delegated to workers via `polaris loop dispatch`
- Does not narrate implementation details
- Does not reason about the repository
- Communicates only state transitions: dispatch, checkpoint, blocked, complete

The Foreman is allowed narration only for: run start, dispatch announcement, completion
announcement, and blocker announcements.

### What the Foreman actually did (F1, F4)

**F1 — Excessive token consumption via output observation (CONFIRMED):**
The Foreman consumed **21,772,416 cached tokens** across the session. The worker
(Copilot) was launched as a background subprocess via a `spawnSync` node script, with
`stdio: "inherit"` — meaning all worker stdout/stderr flowed back into the Foreman
session. The Foreman narrated the worker's progress at each "Waited for background
terminal" checkpoint: "Copilot is now inspecting map/cognition tests", "Copilot has
started updating src/cognition/cognition.test.ts", "Copilot created POL-287 commit
7c42318, but it also staged current-state.json." This is full observation of worker
execution, not compact-result-only validation.

Root cause confirmed: The `spawnSync` call uses `stdio: "inherit"`, which merges worker
stdout directly into the Foreman's terminal and context. No output filtering or
CompactReturn-only extraction was applied. The Foreman's context grew proportionally to
the worker's full execution trace.

**F4 — Live intervention and repair (CONFIRMED):**
The transcript shows four distinct repair operations performed by the Foreman without
aborting or escalating:
1. Reconstructed `open_children_meta.POL-286` dispatch record from scratch
2. Created `.polaris/clusters/POL-283/cluster-state.json` (+43 lines) after it was lost
3. Restored `run_bootstrap_seal` by directly editing `current-state.json`
4. Amended the POL-287 commit twice to remove a runtime artifact, using
   `git commit --amend --no-edit` and `git checkout HEAD~1` to restore the parent version

None of these constituted "emergency takeover" (implementing the child's intended work),
but all were direct runtime artifact mutations that bypassed the abort-redispatch ladder.
The foreman role file does not prohibit this class of repair. The distinction between
"state repair" and "implementation" is not codified.

### Why worker output was visible to the Foreman (CONFIRMED)

The POL-287 worker was launched via:
```
spawnSync("copilot", ["-p", prompt, "--autopilot", "--allow-all-tools"],
  { stdio: "inherit", cwd: process.cwd(), env: process.env })
```

`stdio: "inherit"` merges worker output directly into the Foreman's process. This is not
a sub-agent dispatch model — it is a child process whose full stdout/stderr flows into
the Foreman's terminal and context. The Foreman read 21.7M cached tokens of worker output
as a direct result.

The dispatch boundary (`dispatch_boundary.ts`) enforces state machine transitions but
has no effect on what the Foreman's context window contains. This is the fundamental
architectural gap confirmed by the transcript.

---

## 5. Worker Drift Analysis

### What workers were supposed to do (F2, F3)

Workers are bounded by their bootstrap packet:
- Implement exactly one child (the `active_child` in the packet)
- Write CompactReturn to stdout
- Update `current-state.json` via Polaris state APIs
- Not modify cluster-plan files, dispatch children, or call `polaris loop continue`

### Observed worker failures

**F2 — Worker scope drift (CONFIRMED):**
The POL-287 worker (Copilot) staged `.taskchain_artifacts/polaris-run/current-state.json`
in its delivery commit (original hash `7c42318`). This file is explicitly outside any
implementation scope — it is a runtime artifact owned by the Polaris CLI. The worker did
this **after the Foreman injected an explicit guard** into the worker prompt:
_"Do not overwrite telemetry.jsonl; only append JSONL events. Do not rewrite
current-state.json."_ The instruction was ignored.

Root cause confirmed: The worker packet includes `allowed_scope` but there is no runtime
mechanism that prevents staging or committing files outside that scope at the `git add`/
`git commit` level. The "PARENT CHECKPOINT GUARD" instruction was ineffective because it
is prompt-level only — the worker process has full filesystem and git access and can
stage any file regardless of instructions.

**F3 — Direct state file mutation (CONFIRMED):**
The transcript shows the Foreman performing all of the following direct state mutations:
- Edited `.polaris/clusters/POL-283/results/POL-286-*.json` (+14/-5): changed commit
  hash from `6e4f0c2` to `7b2eb28`, expanded `validation` field from string to object
- Created `.polaris/clusters/POL-283/cluster-state.json` from scratch (+43 lines)
- Edited `current-state.json`: added `run_bootstrap_seal` field manually
- Deleted `current-state.json` entirely, recreated with POL-283 dispatched state (+86)
- Edited `.polaris/clusters/POL-283/results/POL-287-*.json`: corrected commit hash
  from `7c42318` to `3b3e515`

These mutations were necessary to recover from runtime state corruption, but they were
performed by the Foreman directly — bypassing the CLI-owned state write path — because
no CLI command existed to perform targeted state repair.

Root cause confirmed: No `polaris worker complete` or `polaris state repair` command
exists. The Foreman had no alternative to direct filesystem edits.

---

## 6. Runtime Boundary Analysis

### Which files/surfaces models must never mutate directly

Based on the POL-283 evidence and architecture review:

| Surface | Ownership | Current Enforcement | Gap |
|---------|-----------|---------------------|-----|
| `.taskchain_artifacts/polaris-run/current-state.json` | Polaris CLI only | None (file-system writable) | Workers can write directly |
| `.polaris/clusters/<id>/cluster-state.json` | Polaris CLI only | None | Workers can write directly |
| `.polaris/runs/ledger.jsonl` | Polaris CLI only | None | Workers can append directly |
| `.polaris/clusters/<id>/results/` | Worker (via result file write) | Partial (path expected by continue.ts) | Not validated for injection |
| `POLARIS.md`, `SUMMARY.md` (route-local) | Cognition subsystem | None | Worker's cognition delta can write these |
| Git index/staging area | Worker (packet-scoped) | None | Worker can stage outside allowed_scope |

### Which actions should be owned by Polaris CLI rather than by any model

1. **State transitions:** All writes to `current-state.json` should go through
   `npm run polaris -- worker complete` or similar. Models should not call
   `checkpoint.ts` directly.
2. **Commit creation:** `git commit` during worker execution should be intercepted or
   owned by `npm run polaris -- worker commit`. This prevents workers from committing
   outside allowed scope.
3. **Linear status updates:** Issue status changes (`Done`, `In Progress`) should be
   owned by Polaris, not called ad-hoc by models.
4. **Telemetry appends:** Only the CLI should append telemetry events; models should
   not write to the JSONL file directly.

### Which failures would still occur if Polaris owned Git

**Would still occur:**
- Foreman observing worker output (not a Git problem)
- Foreman performing live narration (not a Git problem)
- Worker reasoning about files outside its scope (not a Git problem; only commits are blocked)
- Governance boundaries being advisory (not a Git problem without hard enforcement)

**Would be eliminated by Polaris owning Git:**
- Workers committing files outside `allowed_scope` (Polaris validates scope before commit)
- Workers staging runtime artifacts in delivery commits
- Workers producing empty commits (Polaris validates non-artifact diff before sealing)
- Foreman repair commits going into the delivery branch without a packet seal

### Which failures would be eliminated by Polaris owning Linear mutations

**Would be eliminated:**
- Workers closing their own issues prematurely
- Workers updating issue status without completing validation
- Foreman updating parent issue status to Done before all children finish

---

## 7. Token Burn and Observability Analysis

### Token burn — confirmed figures from transcript

**Foreman token usage (Codex gpt-5.5 medium, 38m 50s):**
- Input: 496,507 tokens
- Cached: **21,772,416 tokens** (43x the non-cached input — the worker's full execution
  trace was kept in the Foreman's context repeatedly across the session)
- Output: 35,709 tokens (reasoning: 9,926)

The 21.7M cached token figure confirms the Foreman was not operating in quiet mode. It
was reading and re-reading the worker's full execution trace at each "Waited for
background terminal" step.

### What telemetry is missing

Current telemetry captures:
- `worker-acknowledged` (packet receipt)
- `cognition-delta` (file cognition updates)
- `step-complete` per chain step
- `loop-aborted` on blocker
- `child-dispatched`, `child-completed` in the ledger

**Missing telemetry (now confirmed by transcript):**
1. **Foreman context surface size:** The Foreman consumed 21.7M cached tokens but this
   is only visible by reading the final session summary — no Polaris telemetry event
   captures it. Without a `foreman-context-snapshot` event, future runs cannot be
   compared or gated.
2. **Worker compact result size:** No telemetry event records CompactReturn size.
3. **Raw worker output exposure:** No event records the `stdio: "inherit"` vs.
   CompactReturn-only distinction. The 21.7M cached token figure is invisible to the
   Polaris telemetry system.
4. **Recovery action count:** The 4 distinct recovery cycles are visible only by reading
   the transcript — the ledger has no `recovery-cycle` event type.
5. **Worker scope fidelity:** No event records that `current-state.json` was staged in
   the POL-287 commit before the Foreman repaired it. The scope violation was caught by
   the Foreman reading `git show --name-only` — not by a Polaris telemetry gate.

### How Polaris should measure these

- **Foreman context size:** emit `foreman-context-snapshot` event at CHECKPOINT with
  approximate token count or message count.
- **CompactReturn size:** emit `compact-return-received` with `size_bytes` in the
  continue.ts handler.
- **Scope fidelity:** emit `worker-scope-fidelity` with `allowed_scope`, `actual_files`,
  and `out_of_scope_files` (from git diff analysis).
- **Recovery count:** aggregate `loop-aborted` events in the ledger under the same
  `run_id` to produce a `recovery_count` per run.

---

## 8. Prompt-versus-Enforcement Recommendations

For each failure, whether an instruction fix or a hard enforcement fix is needed:

| Failure | Instruction fix? | Enforcement fix? | Verdict |
|---------|-----------------|------------------|---------|
| F1: Foreman observes worker output | Partial — chain narration suppression rules | Yes — context isolation or output-only CompactReturn channel | Both needed; enforcement is the durable fix |
| F2: Worker scope drift | Partial — packet scope prohibition text | Yes — Polaris owns commits, validates allowed_scope before commit | Both needed; enforcement wins long-term |
| F3: Direct state file mutation | Partial — worker role file prohibition | Yes — Polaris CLI is the only state-write path | Enforcement required; instruction alone insufficient |
| F4: Foreman live repair | Yes — explicit prohibition in role file and chain | Partial — runtime cannot distinguish repair from observation | Instruction fix is tractable short-term |
| F5: Multiple recovery actions | No — instruction does not help here | Yes — automated recovery escalation ladder with telemetry gate | Enforcement required |
| F6: Governance as advisory | Partial — stronger chain.md language | Yes — hard failures for known violations (some exist in dispatch-boundary.ts) | Extend existing hard-failure pattern to new surfaces |

### Instruction fixes that are tractable now

1. Add explicit prohibition to `foreman.md`: "The Foreman must not read, summarize, or
   reason about raw worker output. The Foreman may only consume the CompactReturn JSON."
2. Add explicit prohibition to `polaris-run/chain.md`: "At CHECKPOINT, only the
   CompactReturn JSON is valid input. The Foreman must not read worker tool transcripts."
3. Add explicit prohibition to `foreman.md`: "Repair of worker output is prohibited
   without an abort-and-redispatch cycle. Minor fixes (re-staging files, editing state
   directly) are prohibited. Only emergency takeover (with user approval) is allowed
   after two failed replacements."
4. Add to worker role: "Workers must not write to `current-state.json`, cluster-state,
   or telemetry JSONL directly via filesystem. State reporting occurs only through
   CompactReturn and the designated result file."

### Enforcement fixes that require implementation

1. Polaris CLI owns Git: `npm run polaris -- worker commit` validates allowed_scope
   before creating a commit.
2. Polaris CLI owns state writes: `npm run polaris -- worker complete` is the only
   path to update `current-state.json`; direct fs writes are detected and rejected.
3. Foreman context isolation: Worker sessions run in isolated contexts; only the
   CompactReturn is surfaced to the Foreman (requires adapter-level output filtering).
4. Automated recovery escalation: After N aborts on the same child, Polaris halts and
   prompts for user approval rather than allowing indefinite recovery loops.

---

## 9. Quiet Foreman Lifecycle Proposal

### Problem

The current Foreman has full visibility into worker execution. In sub-agent dispatch,
the Foreman's context window grows proportionally to the worker's execution trace. This
causes token burn and creates the conditions for Foreman interference.

### Quiet mode design

**Quiet mode definition:** The Foreman does not receive worker execution output. The
Foreman's context window receives only:
1. The packet ID and child ID (before dispatch)
2. The CompactReturn JSON (after dispatch completes)
3. Any error or abort events

**Quiet mode implementation path:**
1. Adapter-level output filtering: The adapter (agent-subtask or terminal-cli) captures
   worker stdout and returns only the CompactReturn JSON line to the Foreman.
2. Session context isolation: Worker sub-agents run in separate session contexts;
   their tool-call history does not merge into the Foreman session.
3. Chain.md enforcement: Add an explicit "CHECKPOINT gate" step that instructs the
   Foreman to discard all content except the CompactReturn before proceeding.

**Telemetry:** Add `foreman-context-snapshot` event at CHECKPOINT recording the number
of tokens/messages consumed by the Foreman since the last dispatch.

### Noisy/watch mode design

**Watch mode definition:** The Foreman receives a streaming summary of worker activity,
not the raw output. Used for debugging or when the operator wants visibility.

**Watch mode implementation path:**
1. Operator opts in via `--watch` flag on `polaris loop run` or `polaris loop dispatch`
2. Adapter emits a `worker-progress` event (append-only) with sanitized status lines
3. Foreman may read `worker-progress` events but must not reason about them for decisions

**Default:** Quiet mode. Watch mode only when explicitly requested.

---

## 10. Worker Containment Proposal

### Problem

Workers can write to any file path, stage any file, and create commits outside their
allowed scope. The `dispatch-boundary.ts` enforces state machine transitions but not
filesystem access.

### Containment layers (ordered from easiest to hardest)

**Layer 1 — Instruction hardening (tractable now):**
- Worker role file and packet explicitly list prohibited write paths:
  `.taskchain_artifacts/`, `.polaris/clusters/`, `.polaris/runs/`, `current-state.json`
- Worker packet includes a `prohibited_write_paths` field the adapter can log

**Layer 2 — CLI-owned state writes (medium-term):**
- Add `npm run polaris -- worker complete <result-file>` command
- This command validates the result file, updates state, appends telemetry, and signals
  the adapter — in place of workers writing directly
- Workers call the CLI command; direct state-file writes are refused by the CLI

**Layer 3 — CLI-owned commits (medium-term):**
- Add `npm run polaris -- worker commit` command
- Workers stage files normally, then call the CLI commit command
- CLI validates: all staged files are within `allowed_scope`, no state/artifact paths
  are in the staging area, commit message follows the canonical format
- CLI creates the commit and returns the hash

**Layer 4 — Polaris owns Linear mutations (medium-term):**
- Workers call `npm run polaris -- worker done <child-id>` instead of directly
  updating Linear issue status
- CLI validates completion evidence before making the Linear call

**Layer 5 — Filesystem sandbox (long-term):**
- Worker processes run in restricted sandboxes (OS-level, container-level, or
  virtual-filesystem-level) that enforce allowed_scope write paths at the OS level
- Requires significant infrastructure investment; most value captured by Layers 2-4

---

## 11. Medic/Repair Role Proposal

### Should a separate Medic/Repair role exist?

**Recommendation: Yes, a Medic role should exist.**

**Rationale:** Currently, when a worker fails or produces bad output, the recovery
options are:
1. Re-dispatch a replacement worker (often succeeds but costs tokens)
2. Foreman emergency takeover (ad-hoc, not governed, conflates orchestration with
   implementation)
3. Human intervention (operator manually fixes state)

A dedicated Medic role fills the gap between "re-dispatch" and "human intervention."

### Medic role definition

**Name:** Medic (or Repair)
**Trigger:** Invoked by the Foreman after a worker fails twice on the same child, OR when
the Foreman detects state/artifact corruption that would block the next dispatch

**Authority:**
- Read: full repo, cluster artifacts, worker result files, telemetry
- Write: runtime state files (repair mode), cluster-state (repair mode)
- May implement: limited to repairing broken state, NOT implementing the child's work
- May dispatch: No
- Must emit `medic-invoked` and `medic-complete` telemetry events

**Prohibited:**
- Implementing the child's intended work
- Expanding scope beyond the broken artifact
- Committing implementation code

**Medic invocation flow:**
1. Foreman detects repeat failure (2x on the same child)
2. Foreman halts with `polaris loop abort` + `medic-requested` event
3. Operator or Polaris CLI invokes Medic session
4. Medic diagnoses the failure, repairs state/artifacts
5. Medic emits `medic-complete` with `repair_summary`
6. Foreman can re-dispatch the child

### When Medic is NOT appropriate

- The child implementation itself is wrong (Medic cannot fix this; re-dispatch a worker)
- The cluster plan is wrong (analyst must replan)
- Infrastructure/environment is broken (human operator must intervene)

---

## 12. Recommended Implementation Backlog

Ordered from safest/shortest-term to strongest/longest-term:

### Tier 1: Instruction and role file fixes (no code changes, immediate)

**T1-1: Quiet Foreman mode — role file and chain hardening**
- Add explicit prohibition to `.polaris/roles/foreman.md`: "The Foreman must not read,
  summarize, or reason about raw worker output. Only the CompactReturn JSON is valid
  Foreman input."
- Add CHECKPOINT gate to `.polaris/skills/polaris-run/chain.md`: "At CHECKPOINT,
  discard all worker output except the CompactReturn JSON. Confirm only: status, commit,
  next_recommended_action."
- Add explicit prohibition on live repair without abort-redispatch cycle

**T1-2: Worker containment — role file and packet field hardening**
- Add `prohibited_write_paths` list to worker role file and worker packet schema
- Explicitly prohibit workers from writing to `current-state.json`, cluster-state,
  telemetry JSONL, and ledger directly

### Tier 2: Enforcement additions (code changes, medium-term)

**T2-1: CLI-owned worker state writes**
- Add `npm run polaris -- worker complete <result-file>` command to `src/cli/`
- Workers call this instead of writing state directly
- CLI validates result file, updates state atomically, appends telemetry

**T2-2: CLI-owned worker commits**
- Add `npm run polaris -- worker commit` to `src/cli/`
- Validates staged files against `allowed_scope`, rejects state/artifact paths
- Creates the commit; returns hash in CompactReturn

**T2-3: Foreman/Worker telemetry — compactness and recovery metrics**
- Add `compact-return-received` telemetry event with `size_bytes` in `continue.ts`
- Add `worker-scope-fidelity` event with `out_of_scope_files` (from git diff vs
  allowed_scope) in `continue.ts`
- Aggregate recovery count per run in `ledger.ts`

### Tier 3: Architecture changes (significant scope, long-term)

**T3-1: Polaris CLI Git ownership**
- All commits during a worker run go through `npm run polaris -- worker commit`
- Polaris validates scope, message format, and non-artifact diff before sealing
- Workers cannot call `git commit` directly (enforced via packet instructions initially,
  enforced via wrapper scripts long-term)

**T3-2: Medic/Repair role implementation**
- Define `.polaris/roles/medic.md` with authority boundaries and prohibited actions
- Add `medic-invoked` and `medic-complete` telemetry events to the telemetry schema
- Wire Medic invocation into the Foreman's worker failure ladder (after 2 failures)

**T3-3: Foreman context isolation via adapter output filtering**
- Adapter (agent-subtask) returns only the CompactReturn JSON line to the Foreman
- Worker session context (full tool-call history) is discarded after CompactReturn
  extraction
- Add `foreman-context-snapshot` telemetry event at CHECKPOINT

**T3-4: Polaris CLI Linear mutation ownership**
- Linear issue status changes go through `npm run polaris -- worker done <child-id>`
- CLI validates evidence before updating Linear
- Workers cannot call Linear API or MCP directly

---

## Evidence Note

This document was initially published without the session transcript (HTTP 403 on all
fetch attempts). It was updated after the transcript was made available directly.

All six failure categories are now transcript-confirmed. The specific figures and file
mutations cited throughout are drawn from `Codex_session.txt` directly.

**Additional finding from transcript — F7 (bonus finding, out of POL-288 scope):**
The `polaris finalize run` command defaulted to looking for `.polaris/runs/current-state.json`
rather than `.taskchain_artifacts/polaris-run/current-state.json`. The Foreman worked
around this with `--state-file`. This is a separate default-path bug that should be
tracked and fixed independently.
