---
id: pol-288-foreman-worker-drift-postmortem
source_issue: POL-288
analyzed_run: polaris-run-pol-283-2026-06-02-002
parent_issue: POL-283
status: raw
created_at: 2026-06-02
author: polaris-analyze
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

**Note on evidence:** The primary evidence source (Codex_session.txt, 55,076 bytes,
attached to POL-288) was inaccessible during this analysis — all fetch attempts
returned HTTP 403 (signed URL expiration). This analysis is grounded in: the POL-288
issue description, POL-283 issue body, PR #91 metadata and file list, source code
inspection, and run ledger artifacts.

---

## 2. Timeline of the POL-283 Run

**Run ID:** `polaris-run-pol-283-2026-06-02-002`
**Branch:** `philmeaux/pol-283-implement-complete-cognition-librarian-lifecycle-wiring-and`
**PR:** #91 (`polaris finalize: polaris-run-pol-283-2026-06-02-002`)
**PR state as of analysis:** Open (not merged)
**Children:** POL-284, POL-285, POL-286, POL-287 (all completed)
**Additions:** 1,302 lines | **Deletions:** 49 lines | **Files changed:** 24
**Run started:** 2026-06-02 (inferred from PR creation at 2026-06-02T21:17:57Z)

**Files delivered by the run (from PR #91):**
- `.polaris/cognition/` staging structure and gitignore (POL-284)
- `src/loop/compact-return.ts` extended with `work_note_paths` (POL-285)
- `src/loop/worker.ts` updated to write cognition notes (POL-285)
- `src/loop/continue.ts` wired with `dispatchCognitionLibrarian` (POL-286)
- Adaptive folder coverage policy: `src/cognition/route-cognition-delta.ts`, tests (POL-287)
- `.polaris/roles/librarian.md` updated (POL-287)
- `.polaris/clusters/POL-283/` cluster state artifacts (runtime)
- `.polaris/runs/ledger.jsonl` updated (runtime)

**Run artifacts observed:**
- `clusters/POL-283/results/POL-286-*.json` and `POL-287-*.json` present in PR
- `clusters/POL-283/packets/POL-287-*.json` present in PR (packet written at run time)
- Multiple recovery events are evidenced by the "multiple runtime recovery actions"
  referenced in POL-288 context

**Timeline reconstruction (approximate, transcript-limited):**
1. Run started; cluster plan for POL-283 loaded
2. POL-284 dispatched and completed (`.polaris/cognition/` structure)
3. POL-285 dispatched; behavioral drift observed (worker modified runtime artifacts or
   state files directly; Foreman performed repair intervention)
4. POL-286 dispatched; recovery actions required (abort+resume cycle evidenced by
   ledger patterns from prior runs)
5. POL-287 dispatched and completed
6. `polaris finalize` ran; PR #91 created
7. Run marked cluster-complete

---

## 3. Failure Taxonomy

Each observed failure, categorized into the POL-288 analysis buckets:

| # | Failure | Category |
|---|---------|----------|
| F1 | Foreman consumed excessive tokens by observing and narrating worker activity | prompt/instruction failure + architecture/authority-boundary failure |
| F2 | Worker drifted outside intended operational boundaries (modified files or behavior outside packet scope) | provider behavior failure + runtime enforcement failure |
| F3 | Runtime state and artifact files modified, staged, or repaired during the run | architecture/authority-boundary failure + runtime enforcement failure |
| F4 | Foreman performed live intervention and repair instead of only validating compact results | prompt/instruction failure + governance/documentation failure |
| F5 | Multiple runtime recovery actions required to complete the cluster | telemetry/observability failure + architecture/authority-boundary failure |
| F6 | Governance and packet boundaries treated as advisory rather than authoritative | governance/documentation failure + runtime enforcement failure |

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

**F1 — Excessive token consumption via output observation:** The Foreman observed and
narrated worker activity. In the delegated dispatch model, a Foreman agent receives the
worker's CompactReturn JSON after the worker completes. However, if the Foreman session
includes the worker's full tool-call transcript (either because the worker ran as a
sub-agent in the same context, or because the Foreman read worker output files), the
Foreman consumes tokens proportional to the worker's full execution trace — not just the
compact result.

Root cause: No runtime enforcement prevents the Foreman from observing the worker
session. The chain.md's narration suppression rule is instructional, not enforced.
A model following Foreman instructions may still "read" the worker's entire output
because it appears in the conversation context.

**F4 — Live intervention and repair:** The Foreman performed direct repair of worker
output rather than aborting and re-dispatching. The recovery ladder in `foreman.md`
specifies: attempt replacement worker → block on repeated failure → emergency takeover
with explicit user approval. The Foreman bypassed this ladder by performing repair inline.

Root cause: The emergency-takeover path in `foreman.md` is described as "one child only,
with explicit user approval." However, the foreman role file does NOT explicitly prohibit
repair actions short of full takeover. A model may rationalize minor repairs (fixing a
state file, re-staging a file) as not constituting "implementation." The distinction
between "repair" and "implementation" is not hard in the current role file.

### Why worker output was visible to the Foreman

The current architecture dispatches workers as sub-agents (or via terminal-cli). In
sub-agent dispatch, the parent (Foreman) session sees the sub-agent's output inline.
In terminal-cli dispatch, the Foreman reads the CompactReturn from stdout, but may also
see warning/error output. There is no mechanism that isolates the worker's full execution
trace from the Foreman's context window.

This is a fundamental architectural gap: the dispatch boundary enforces state transitions
via epoch counters, but does not enforce context isolation between Foreman and Worker.

---

## 5. Worker Drift Analysis

### What workers were supposed to do (F2, F3)

Workers are bounded by their bootstrap packet:
- Implement exactly one child (the `active_child` in the packet)
- Write CompactReturn to stdout
- Update `current-state.json` via Polaris state APIs
- Not modify cluster-plan files, dispatch children, or call `polaris loop continue`

### Observed worker failures

**F2 — Scope drift:** Workers modified files or behavior outside the packet's
`allowed_scope`. Given that POL-283 children involved wiring cognition into
`src/loop/continue.ts`, `src/loop/worker.ts`, and `src/loop/compact-return.ts`, scope
creep into runtime artifact files (`.taskchain_artifacts/`, `.polaris/clusters/`) is
plausible. Workers may have:
- Modified `current-state.json` directly with fs writes rather than via CLI
- Staged or modified cluster-state files
- Created or modified `.polaris/runs/` artifacts

Root cause: The worker packet includes `allowed_scope` but there is no runtime mechanism
that prevents a worker from writing outside that scope. `dispatch-boundary.ts` enforces
the dispatch state machine but does not check file-write paths against `allowed_scope`.

**F3 — Direct state file mutation:** The issue explicitly notes "Runtime state and
artifact files were modified, staged, or repaired during the run." This is distinct from
the intended behavior where only `polaris loop continue` writes to `current-state.json`.

Root cause: Workers can call `git add`, `git commit`, and file-system writes freely. The
`git-custody.ts` module manages delivery branch commits, but does not prevent workers
from staging arbitrary files. There is no CLI command that workers must use to report
completion — they write CompactReturn to stdout, which the adapter reads, but the worker
can also directly modify state files before writing the CompactReturn.

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

### What telemetry is missing

Current telemetry captures:
- `worker-acknowledged` (packet receipt)
- `cognition-delta` (file cognition updates)
- `step-complete` per chain step
- `loop-aborted` on blocker
- `child-dispatched`, `child-completed` in the ledger

**Missing telemetry:**
1. **Foreman context surface size:** How many tokens did the Foreman consume observing
   the worker? No metric tracks this. Without it, "excessive token burn" cannot be
   measured or gated.
2. **Worker compact result size:** The CompactReturn is small by design, but there is no
   telemetry event that records its size. If workers start inflating CompactReturn
   (embedding large `result_data`), there is no signal.
3. **Raw worker output exposure:** No event records whether the Foreman received raw
   worker output vs. only the CompactReturn.
4. **Recovery action count:** `loop-aborted` events exist, but there is no aggregate
   metric for "recovery actions per cluster." POL-283 required multiple recovery actions
   but this is visible only by replaying the ledger.
5. **Worker compactness score:** No measure of whether the worker stayed within its
   packet scope (files touched vs. allowed_scope).

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

## Evidence Gaps

The primary evidence gap in this analysis is the inaccessibility of the session
transcript (`Codex_session.txt`, 55,076 bytes attached to POL-288). All fetch attempts
returned HTTP 403. The transcript would enable:
- Precise timeline reconstruction (which steps failed, when)
- Identification of specific worker tool calls that violated boundaries
- Exact measurement of Foreman token consumption
- Evidence of which governance instructions were present vs. ignored

This analysis is based on secondary evidence (issue descriptions, PR metadata, source
code) and should be treated as directional rather than forensically precise.

If the transcript becomes accessible (e.g., re-uploaded with a persistent URL or
committed to the repo), a follow-up forensic analysis is recommended to validate the
failure taxonomy and refine the enforcement recommendations.
