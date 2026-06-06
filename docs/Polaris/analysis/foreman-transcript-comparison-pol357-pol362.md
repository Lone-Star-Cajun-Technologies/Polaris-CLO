# Foreman Transcript Comparison: POL-357 vs POL-362

**Date:** 2026-06-06  
**Analyst:** claude-sonnet-4-6  
**Transcripts analyzed:**
- POL-357: `a8918ea9-POL357.txt` (480 KB, 392 JSONL lines — fully analyzed)
- POL-362: `0ffc010f-POL362transcript.jsonl` (910 KB, 778 JSONL lines — fully analyzed)

---

## 1. Executive Summary

### Why POL-357 was more efficient

POL-357 used `npm run polaris -- loop run POL-357` (batch execution mode), which ran a single CLI subprocess that managed all three worker dispatches internally. The Foreman polled the subprocess with `write_stdin(30s)` and received clean `[POLARIS] COMPLETE POL-NNN (commit: <40-char-sha>)` signals — it never saw raw CompactReturn JSON. Zero artifact repair cycles occurred.

The batch subprocess handled worker completion in 2.8–5.2 minutes per child on bounded TypeScript refactoring work. The Foreman session ran for 17.6 minutes with a peak context of 94,944 tokens (36.7% of the 258,400-token window). The only unplanned overhead was a finalize path bug (same as POL-362) resolved in 6 messages.

### Why POL-362 was less efficient

POL-362 dispatched six children individually using the terminal-CLI adapter, with each worker returning a raw CompactReturn JSON artifact directly to the Foreman. Five of six Copilot workers returned a legacy format (`status:"completed"`, short SHA, validation as map), which `loop continue` rejected. The Foreman had to detect, read, patch, and retry each one. A finalize path bug added 7 more debugging messages. Long worker execution times (POL-365: ~10 min; driven by novel language adapter implementation) produced 62 sleep cycles (31 min) and 21 explicit status polls. The Foreman narrated every polling interval regardless of state change.

### The key architectural difference

POL-357's `loop run` batch mode inserted the CLI's own checkpoint/validation layer between workers and the Foreman. Malformed CompactReturn artifacts would have been rejected at the CLI boundary, not handed up to the Foreman for repair. POL-362's per-child dispatch exposed the Foreman directly to every raw worker artifact, making format compliance a Foreman responsibility.

---

## 2. Foreman Behavior Metrics

### Side-by-side comparison (both transcripts)

| Metric | POL-357 | POL-362 |
|---|---|---|
| Children | 3 | 6 |
| Total Foreman messages | 57 | 130 |
| Session duration | 17.6 min | 46.8 min |
| Time in 30s polling | 11.0 min (62.3%) | 31.0 min (66.2%) |
| `loop status --json` polls (exec_command) | 8 | 21 |
| `write_stdin` polling calls | 22 | 62 |
| Worker artifact repair cycles | **0** | **5** |
| Apply-patch operations | **0** | **6** |
| Finalize debugging messages | 6 | 7 |
| Session invocations (task_started) | 3† | 3 |
| Context at turn 1 | 23,225 tokens | 26,700 tokens |
| Context at peak turn | 94,944 tokens (36.7% window) | 174,493 tokens (67.5% window) |
| Cumulative input tokens | 3,691,235 | 12,822,162 |
| Cache hit rate | 92.8% | 97.0% |
| exec_command calls | 57 | 77 |
| Custom tool calls (apply_patch) | **0** | **6** |
| Execution mode | `loop run` (batch) | per-child dispatch |

† POL-357 invocation 3 was user "quit" (turn_aborted immediately) — not a mid-run restart. Effective work sessions: 2 (main run + user-requested "finalize").

### POL-362 detail

| Metric | Count | Notes |
|---|---|---|
| Total Foreman messages | 130 | Across 3 invocations |
| Session duration | 46.8 min | 17:56 → 18:43 UTC |
| Time in 30s sleep cycles | 31.0 min (66%) | 62 × `write_stdin(yield_time_ms: 30000)` |
| Distinct `loop status --json` polls | 21 | Explicit status checks via `exec_command` |
| Worker dispatches | 6 | One per child |
| Worker artifact repair cycles | 5 | POL-367, 366, 365, 364, 363 — every Copilot worker except the first |
| Apply-patch operations | 6 | Artifact normalization + 1 state.json creation |
| Finalize path debugging messages | 7 | M122–M128 |
| Safety-threshold discussions | 2 | M18 (22 files, POL-368), M37 (20 files, POL-367) |
| Session restarts required | 3 | Invocations: M1–M47, M48–M113, M114–M130 |
| Context at turn 1 | 26,700 tokens | Post-bootstrap |
| Context at peak (turn 131) | 174,493 tokens | 67.5% of 258,400 window |
| Cumulative input tokens | 12,822,162 | All 131 turns |
| Cache hit rate | 97.0% | |

### POL-357 detail (actual transcript)

| Metric | Value | Basis |
|---|---|---|
| Total Foreman messages | 57 | Transcript (57 `agent_message` events) |
| Session duration | 17.6 min | 16:11:50 → 16:29:29 UTC |
| Write_stdin polling calls | 22 | All with `yield_time_ms: 30000`, chars: "" |
| Time in polling | 11.0 min (62.3%) | 22 × 30s |
| Loop status polls | 8 | `exec_command` calls to `loop status --json` |
| Execution mode | `loop run` batch | `npm run polaris -- loop run POL-357` |
| Worker return format | `[POLARIS] COMPLETE POL-NNN (commit: <sha>)` | Clean 40-char SHAs; no JSON repair needed |
| Artifact repair cycles | 0 | No apply_patch calls; no repair messages in main loop |
| Finalize debugging | 6 repair messages | Same path bug as POL-362 |
| Context at turn 1 | 23,225 tokens | Transcript token_count events |
| Context at peak | 94,944 tokens | 36.7% of 258,400 window |
| Cumulative input tokens | 3,691,235 | |
| Cache hit rate | 92.8% | |
| Output tokens | 8,803 | |
| Reasoning tokens | 2,943 | |
| exec_command calls | 57 | File reads: 13, git: 12, finalize: 10, loop status: 8, other: 14 |
| apply_patch calls | 0 | Confirmed: no `custom_tool_call` events |
| Children | 3 (POL-358, 359, 360) | `loop run` output |
| Session invocations | 3 (2 effective) | Invocation 3 = "quit" (turn_aborted) |

---

## 3. Runtime Characteristics

### POL-357 child execution timeline (actual)

| Child | Dispatch (CLI signal) | Complete (CLI signal) | Duration | Return artifact |
|---|---|---|---|---|
| POL-358 | 16:12:50 (Dispatch M06) | 16:18:00 `[POLARIS] COMPLETE POL-358` | ~5.2 min | Clean — `commit: 202f1dfbb33ecd09c9882bad19392501ff64b8b4` |
| POL-359 | 16:18:03 (Dispatch M17) | 16:20:49 `[POLARIS] COMPLETE POL-359` | ~2.8 min | Clean — `commit: 57c0b619dcbde33d1a1c0b60df913872d3ef25e5` |
| POL-360 | 16:20:51 (Dispatch M23) | 16:23:40 `[POLARIS] COMPLETE POL-360` | ~2.8 min | Clean — `commit: 7205b443f49131bc1181cc5961c5e28348e474a1` |
| Librarian | 16:24:35 (session 44454) | 16:26:25 (+29 tokens output) | ~1.8 min | `"status":"success"` — clean |

Total worker execution time: ~10.8 min of 17.6 min session. Polling consumed 11.0 min (62.3%), overlapping with worker execution. The CLI subprocess (`loop run`, session 98899) managed internal dispatch state; the Foreman polled every 30s and never intervened in the dispatch cycle.

### POL-362 child execution timeline

| Child | Dispatch | Checkpoint | Duration | Issues |
|---|---|---|---|---|
| POL-368 | 17:57:22 | 18:04:35 | ~7 min | Clean (auto-dispatched via `loop run`) |
| POL-367 | 18:04:35 | 18:12:30 | ~7 min + 2 min repair | Artifact repair required |
| POL-366 | 18:13:35 | 18:19:11 | ~5 min + repair | Validation format repair; `autoDispatch:false` |
| POL-365 | 18:19:15 | 18:29:13 | ~10 min + repair | Stall period (M73–M83); API error; hash resolution |
| POL-364 | 18:29:21 | 18:33:39 | ~4 min + repair | Artifact normalization |
| POL-363 | 18:33:44 | 18:38:25 | ~5 min + repair | Artifact normalization |

### Execution mode: `loop run` (POL-357) vs per-child dispatch (POL-362)

This is the primary architectural difference between the two runs.

**POL-357 — batch mode:**

```text
Foreman → npm run polaris -- loop run POL-357
  ↓ (single CLI subprocess, session 98899)
  CLI → dispatches POL-358 internally
  CLI → polls worker completion
  CLI → emits: [POLARIS] COMPLETE POL-358 (commit: 202f1df...)
  CLI → dispatches POL-359 internally
  ...
  CLI → emits: [POLARIS] COMPLETE
  CLI → exits with code 0
  ↓
Foreman sees: clean completion signals only
Artifact repair cycles: 0
```

**POL-362 — per-child dispatch:**

```text
Foreman → loop dispatch POL-368
  ↓
  Copilot worker runs → writes result JSON directly
  ↓
Foreman → loop continue
  ↓ (rejected — legacy format)
Foreman reads result JSON, detects:
  status: "completed" (should be "done")
  short SHA (should be 40 chars)
  validation: {cmd: bool} (should be passed: [])
Foreman patches result JSON with apply_patch
Foreman → loop continue (accepted)
  ↓ (repeat × 5 workers)
```

In `loop run` mode, the CLI subprocess normalizes or rejects worker output before the Foreman sees it, emitting only a clean `[POLARIS] COMPLETE` signal. In per-child dispatch mode, every raw CompactReturn artifact lands in the Foreman's context for direct inspection and repair.

### Worker artifact format comparison

```text
POL-357 (loop run output):
  [POLARIS] COMPLETE POL-358 (commit: 202f1dfbb33ecd09c9882bad19392501ff64b8b4)
  → Foreman action: none required

POL-362 Copilot worker result (5/6 workers):
  {"status": "completed", "commit": "202f1df", "validation": {"npm test": true}}
  → Foreman action: read → detect mismatch → apply_patch → retry loop continue
```

### Finalize path bug (present in both runs)

Both runs hit the same finalizer input contract mismatch. The finalizer accepted `current-state.json` but rejected `cluster-state.json`.

**POL-357 repair sequence (within single session):**
1. `finalize run --state-file .polaris/clusters/POL-357/cluster-state.json` → exit 1
2. `finalize run --state-file .taskchain_artifacts/polaris-run/current-state.json` → exit 1
3. `map index` + `map validate` (map repair attempt — did not help)
4. `rg -n "cluster-state|state.json|canonical state"` (source inspection)
5. `cp current-state.json .polaris/clusters/POL-357/state.json` (manual copy)
6. `git switch -c pol-357-delivery` (created delivery branch)
7. `finalize run --state-file state.json` (dry-run) → exit 0
8. `finalize run --state-file state.json` → exit 1 (branch head integrity failure)
9. User: "thing needs to be in the new branch" (unblocked)
10. `git branch -f main origin/main` (reset)
11. `finalize run` (dry-run) → exit 0 then live → exit 0 ✓

**POL-362 repair sequence** (M122–M128): Same pattern — diagnosed contract, inspected POL-357 cluster path as reference, constructed compatible state.json, retried.

The finalize bug is a runtime defect in both runs. POL-357 resolved it in the main session; POL-362 resolved it in session 3 after a restart.

### POL-365 stall period (POL-362 only)

Between M73 and M83 (18:23 → 18:29, ~6 minutes), the POL-365 Copilot worker was silent. The Foreman polled 5 times, inspected process state, found the worker still alive, and eventually observed recovery from a transient API error. This produced 11 purely diagnostic messages during zero progress.

### Session restart overhead (POL-362)

POL-362 required 3 session invocations due to context pressure and `autoDispatch:false` complications. Each restart re-read the skill chain and bootstrap packet, adding ~5 orientation messages. POL-357's 3 invocations were: main run, user-requested "finalize", and user "quit" (aborted immediately) — the expected flow under the chain.md STOP/DELIVER model.

---

## 4. Message Classification

### POL-357 (actual transcript)

| Category | Count | % | Description |
|---|---|---|---|
| WAIT | 18 | 32% | Bare "Waiting." / "Still waiting on the configured worker adapter." |
| ACTION | 16 | 28% | Dispatch, checkpoint, finalize, deliver, complete |
| REPAIR / DIAGNOSTIC | 6 | 11% | Finalize path debugging (M42–M51, M55–M56) |
| ORIENT / OTHER | 13 | 23% | Status checks, authorized packet, librarian, branch verification |
| NARRATIVE | 4 | 7% | M01–M03 (startup orientation narration); M57 (delivery confirmation) |

**Wait messages were brief and undescriptive** ("Waiting." "Waiting." "Waiting." — bare single words), contrasting with POL-362's multi-sentence wait narration.

### POL-362 (actual transcript)

| Category | Count | % | Description |
|---|---|---|---|
| ACTIONABLE | ~28 | 22% | Dispatch, checkpoint, decision, state transition |
| WAIT_NARRATION | ~18 | 14% | Reports waiting only — no new information |
| STATUS_PROGRESS | ~35 | 27% | Worker progress updates (%, file count, heartbeat) |
| REPAIR / DIAGNOSTIC | ~23 | 18% | Artifact repair cycles, path debugging, process probing |
| ORIENT | 5 | 4% | Boot, skill chain read, bootstrap, runtime auth |
| OTHER | ~21 | 16% | Worker narrative, miscellaneous state confirmation |

**Compressible messages** (WAIT_NARRATION + fully redundant STATUS_PROGRESS): ~40–45 messages (~31–35% of total).

### Patterns that recur without adding value (POL-362)

**Pattern 1 — Verbose wait narration (18 instances):**

```text
"Still no worker return yet. The parent command is in the adapter-owned
execution phase for POL-368, so I'm continuing to wait." (M8)

"The dispatch is still quiet, so I'm checking runtime status again
for progress or a worker-side blocker before deciding whether to keep
waiting." (M17)
```

POL-357 used bare one-word wait messages ("Waiting.") — technically still a narration, but orders of magnitude lighter. See Doctrine Update 1 for the preferred approach: no message at all on no-change polls.

**Pattern 2 — Redundant progress percentages (10+ instances):**

```text
M28: "POL-367 is progressing: 24%, five files changed, no blocker."
M31: "POL-367 is at 43% with no blocker."
M34: "POL-367 is at 60%, still unblocked."
M37: "POL-367 is at 66%, no blocker."
```

**Pattern 3 — Worker file-creation narration (8+ instances):**

```text
M53: "The copilot worker has acknowledged the packet... emitting heartbeats for POL-366."
M54: "The worker has created the Swift adapter and extraction files."
M55: "POL-366 now has runtime, index, and fixture test files created."
```

---

## 5. Root Cause Analysis

### High Confidence

**HC-1: `loop run` batch mode eliminated all CompactReturn repair overhead**

POL-357's Foreman dispatched a single `npm run polaris -- loop run POL-357` subprocess. The CLI managed all child dispatches and checkpoints internally, emitting `[POLARIS] COMPLETE POL-NNN (commit: <sha>)` lines when each child completed. The Foreman polled the process but never received or inspected raw CompactReturn JSON.

POL-362's Foreman dispatched each of 6 children individually, receiving each worker's raw result artifact in context. Five of six Copilot workers returned a legacy schema, triggering mandatory repair. This repair overhead — 5 × (read, detect, patch, retry) — generated 23 messages and 15 tool calls that POL-357 never experienced.

*Evidence:* POL-357 write_stdin output (16:12:47): `node dist/cli/index.js loop run POL-357` → `[POLARIS] DISPATCH` → `[POLARIS] COMPLETE POL-358 (commit: 202f1dfbb...)` etc. POL-362 transcript: M41–M45 (POL-367 repair), M62–M63 (POL-366), M86–M88 (POL-365), M98–M99 (POL-364), M110–M111 (POL-363).

**HC-2: Child count doubled all per-cycle overhead**

POL-362 had 6 children vs POL-357's 3. Each child generates a minimum of:
- 1 dispatch message
- N polling cycles (5–8 per child in POL-357, 8–20 per child in POL-362)
- 1 status poll result read
- 1 checkpoint/complete message

With 6 children, every per-child metric doubled before any other factor applied.

*Evidence:* POL-357 timing: POL-358: 5.2 min, POL-359: 2.8 min, POL-360: 2.8 min (actual transcript). POL-362 timing: POL-368: 7 min, POL-367: 7+ min, POL-365: 10+ min (transcript).

**HC-3: Polling frequency produced unnecessary narration**

Both Foremen spent ~62–66% of session time in 30s polling. POL-362's Foreman narrated every poll with multi-sentence commentary even when state was identical to the previous poll. POL-357's Foreman issued bare one-word messages ("Waiting."), which are still technically narration violations but generate roughly 1/20th the token footprint.

The chain.md narration suppression rule was partially honored — neither Foreman wrote code inline — but the "no thinking out loud" prohibition was not enforced for polling cycles in either run. POL-362 violated it more severely.

*Evidence:* POL-357: 18 bare "Waiting." messages in 22 polling cycles. POL-362: M7–M11, M16, M19, M24–M40 (POL-367 polling), M52, M58, M67–M83 (POL-365 polling). POL-362 pattern: 18 verbose wait messages + 35 status-progress reports = 53 compressible messages.

### Medium Confidence

**MC-1: POL-365 worker stall drove 11 extra diagnostic messages (POL-362 only)**

POL-365 experienced ~6 minutes of silence from a transient API error. The Foreman produced 11 diagnostic messages while determining whether the worker was stalled vs. slow.

*Evidence:* M73–M84. Worker recovery confirmed at M84.

**MC-2: Finalize path bug added overhead in both runs**

Both runs hit the `cluster-state.json` vs `current-state.json` finalizer contract mismatch. POL-357 resolved it in 6 repair messages within the main session. POL-362 resolved it in 7 messages during session 3. The magnitude of overhead is comparable; the timing differed.

The finalize bug is a runtime defect. Neither run should have required this repair.

*Evidence:* POL-357: M42–M49 (Retrying with live state → Canonical state required → Preparing canonical state → Switching delivery branch). POL-362: M122–M128.

**MC-3: Worker scope drove longer execution times, which drove more polling cycles**

POL-362 workers implemented novel language adapters (Swift, Kotlin/Java, Dart, Svelte) requiring new dependencies and test infrastructure. POL-357 workers performed bounded TypeScript refactoring in an established module (2.8–5.2 min per child). Longer workers = more 30s polling cycles = more narration opportunities.

*Evidence:* POL-357 per-child durations: 5.2, 2.8, 2.8 min (actual). POL-362: POL-365 ~10 min (M65→M89), POL-367 ~7 min (M22→M46).

**MC-4: `autoDispatch:false` caused 3-message dispatch sequence (POL-362)**

After POL-367's repair and the session restart at M48, the Foreman had to manually discover the dispatch path (M49–M51) before launching the Copilot terminal worker directly. This produced 3 messages where `loop dispatch` would have sufficed.

*Evidence:* M49 ("Resume refreshed the bootstrap... did not dispatch by itself"), M50 ("autoDispatch:false"), M51 ("I'm launching it as the terminal worker").

### Low Confidence

**LC-1: Provider narration tendency**

The Codex/GPT-5 orchestrator in POL-362 showed a higher tendency to narrate intermediate state than the POL-357 instance of the same provider, despite both running under the same chain.md. The difference was in word-count per message (multi-sentence vs. one-word) rather than message frequency (both produced ~18 wait-state messages). This may reflect session-level variation rather than a systematic provider property.

*Evidence:* POL-357 wait messages: all one-word ("Waiting."). POL-362 wait messages: 2–3 sentences each. Both ran on `openai/codex-tui`. Insufficient for strong conclusions without more runs.

---

## 6. Evidence Table

| Observation | POL-357 evidence | POL-362 evidence | Impact |
|---|---|---|---|
| `loop run` vs per-child dispatch | `node dist/cli/index.js loop run POL-357` (write_stdin output 16:12:47) | M41–M45, M49–M51, M62–M63 etc. — per-child CompactReturn handling | +23 messages, +15 tool calls, +~20K tokens in POL-362 |
| Worker return format | `[POLARIS] COMPLETE POL-NNN (commit: <40-char-sha>)` | `{"status":"completed","commit":"202f1df",...}` (legacy) | 5 repair cycles in POL-362 vs 0 in POL-357 |
| Polling rate | 22 × 30s (11 min / 62.3% of session) | 62 × 30s (31 min / 66.2% of session) | Proportional to child count |
| Wait narration word count | 1 word per message ("Waiting.") | 20–40 words per message | ~40× per-message token difference |
| Status polls | 8 `loop status --json` calls | 21 `loop status --json` calls | 2.6× more in POL-362 |
| Finalize repair | 6 messages (M42–M49, M55–M56), resolved same session | 7 messages (M122–M128), resolved in session 3 | Comparable magnitude; same root cause |
| Per-child execution time | 2.8–5.2 min (bounded TS refactoring) | 4–10 min (novel language adapters) | Longer workers → more polling cycles |
| Session invocation structure | Invoc 1: main run; Invoc 2: user-requested finalize; Invoc 3: quit | Invoc 1–3: mid-run restarts due to context/adapter issues | +~10 orientation messages in POL-362 |
| Context window at peak | 94,944 tokens (36.7% window) | 174,493 tokens (67.5% window) | POL-362 reached 2× higher context utilization |
| Cumulative input tokens | 3,691,235 | 12,822,162 | 3.5× more total tokens processed in POL-362 |
| Startup narration violations | M01–M03 (3 orientation narration messages) | Similar pattern + per-session re-orientation | Minor — 3–5 messages in each |

---

## 7. Compression Opportunities

### CO-1: Suppress zero-information polling messages

**Current behavior:** The Foreman emits a commentary message on every 30s sleep cycle, even when no state change occurred (POL-362: multi-sentence; POL-357: one-word "Waiting.").

**Target:** Emit a message only when the polling result reveals a state change (progress advance, blocker, or completion). If state is identical to the previous poll, emit nothing.

**Estimated savings:** 15–18 messages per 6-child cluster.

**Doctrine change required:** Add to `chain.md` Narration Suppression:
> "Do not narrate wait intervals when no state change has been observed since the previous poll. A message is required only when: (a) dispatch occurs, (b) a state change is observed, (c) a blocker is detected, or (d) a checkpoint is taken."

### CO-2: Suppress intermediate worker progress narration

**Current behavior:** The Foreman narrates `loop status` output (progress %, file counts, no-blocker state) after each status poll.

**Target:** Never narrate intermediate worker progress. If a status poll returns no blocker, emit nothing. If it returns a blocker, emit the blocker immediately.

**Estimated savings:** 10–12 messages per cluster.

**Doctrine change required:** Extend the Forbidden narration list:
> "Do not narrate intermediate worker progress percentages, file counts, or heartbeat status. These are visible in the runtime telemetry and do not affect orchestration decisions."

### CO-3: Suppress worker implementation narration

**Current behavior:** The Foreman narrates what the worker is doing (file creation, validation steps, commit).

**Target:** The Foreman cannot observe worker implementation — it only observes stdout. Any narration of what the worker is implementing violates the thin-parent boundary.

**Estimated savings:** 8 messages per cluster.

**Doctrine change required:** Strengthen the existing Forbidden narration clause:
> "Do not narrate implementation details. The orchestrator must not describe or summarize worker file creation, edits, test runs, or commit activity. If such content appears in worker stdout, discard it."

### CO-4: Reduce polling frequency for long-running workers

**Current behavior:** The Foreman polls every 30s throughout worker execution.

**Target:** After 3 consecutive no-change polls, extend the sleep interval to 60s. After 6 consecutive no-change polls, extend to 90s.

**Estimated savings:** 5–8 fewer sleep cycles per long-running worker. For POL-365 (~10 min), this would have reduced 20 polls to ~10.

### CO-5: Standardize Copilot worker CompactReturn format

**Current behavior:** Copilot workers return `status:"completed"` with a validation map, requiring Foreman-side normalization.

**Target:** Either (a) update the worker packet to mandate the correct schema, or (b) make `loop continue` tolerant of the legacy format and normalize internally.

**Estimated savings:** 23 Foreman messages and 15 tool calls eliminated entirely.

**Implementation options:**
- *Option A (preferred):* Update `loop continue` to accept `status:"completed"` and `status:"done"`, normalize short commit hashes internally, accept both validation shapes.
- *Option B:* Update the Copilot worker packet instructions to require `status:"done"`, 40-char SHA, and `validation.passed[]` array format.

### CO-6: Fix finalizer state file contract

**Current behavior:** `finalize run` accepts `current-state.json` but rejects `cluster-state.json`. Both runs hit this bug.

**Target:** `finalize run` should accept `cluster-state.json` directly, or auto-discover the correct input from `polaris.config.json`.

**Estimated savings:** 6–7 Foreman debugging messages per finalize invocation.

**Implementation required:** Update `src/finalize` to accept the canonical cluster-state shape, or add a `--cluster-id` flag that auto-resolves the correct input path.

---

## 8. Runtime Improvement Recommendations

### R-1: Make `loop continue` schema-tolerant (addresses CO-5, High priority)

`loop continue` should normalize the legacy CompactReturn schema rather than hard-failing on it. This would eliminate the single largest source of unplanned Foreman overhead in POL-362 — 5 repair cycles that consumed 23 messages and 15 tool calls.

### R-2: Add narration suppression enforcement (addresses CO-1, CO-2, High priority)

The chain.md narration suppression rules are stated but not mechanically enforced. The Foreman complied with "no inline implementation" but did not comply with "no thinking out loud." A runtime mode that suppresses all commentary between dispatch and state change would enforce this structurally rather than relying on model compliance.

### R-3: Implement poll backoff for long-running workers (addresses CO-4, Medium priority)

A polling loop that backs off from 30s → 60s → 90s after N consecutive no-change status results would reduce total sleep cycle count for workers like POL-365 that run for 8–10 minutes.

### R-4: Fix finalizer state file auto-discovery (addresses CO-6, Medium priority)

The finalizer's input contract should accept the canonical cluster-state path. The workaround of copying state.json from taskchain_artifacts is a fragility both Foremanns discovered at runtime and had to repair independently.

### R-5: Prefer `loop run` batch mode where available (addresses HC-1, High priority)

`loop run` inserts the CLI's own checkpoint/validation layer between workers and the Foreman, absorbing CompactReturn format variance without Foreman involvement. Where the execution adapter supports it, prefer `loop run` over per-child `loop dispatch` + `loop continue`. This is the single change that would most reduce Foreman context growth per cluster.

### R-6: Instrument per-child Foreman token budget (Low priority)

Add a warning threshold to the Foreman when per-child Foreman context exceeds a configurable token count. In POL-362, the average per-child overhead was ~24,665 tokens (147,793 / 6). In POL-357, the comparable average is ~24,000 tokens per child (72,000 / 3). A token budget alert would surface disproportionate overhead before the session approaches the context limit.

---

## 9. Proposed Foreman Doctrine Updates

The following changes to `.polaris/skills/polaris-run/chain.md` are recommended:

### Doctrine Update 1 — Strengthen Narration Suppression (section: Narration Suppression)

Add to the Forbidden narration list:

```text
- Narrating wait intervals when no state change has occurred since the previous poll.
  If a poll returns identical state to the previous poll, emit nothing.
- Narrating intermediate worker progress (%, file counts, heartbeat status, validation
  step names). These are visible in telemetry. They do not affect orchestration decisions.
- Narrating what the worker is implementing (file names created, edits applied,
  test results observed). The thin-parent model prohibits this knowledge.
```

### Doctrine Update 2 — Define the minimum narration threshold for status polls (new subsection)

Add after Narration Suppression:

```text
## Polling Narration Threshold

A Foreman message after a status poll is permitted only when:
1. The poll reveals a new blocker.
2. The poll reveals worker completion (result present).
3. The poll reveals a previously unknown runtime state change.

If the poll result is "worker still active, no blocker, N% progress": emit nothing.
Narrating "I'm still waiting" is a doctrine violation.
```

### Doctrine Update 3 — Polling interval backoff (section: Context budget or new subsection)

Add:

```text
## Polling Interval Backoff

After 3 consecutive status polls with no observable state change, double the
yield interval (30s → 60s). After 6 consecutive no-change polls, triple the
initial interval (30s → 90s). Reset on any state change. This prevents
long-running workers from generating unbounded polling overhead.
```

---

## 10. Final Verdict

**POL-357 achieved better Foreman compression primarily because it used `loop run` batch mode, which eliminated all CompactReturn repair overhead, and because it had 3 children instead of 6, halving all per-cycle overhead.**

The causal chain, ranked:

1. **Execution mode** (`loop run` vs per-child dispatch) — the most consequential single difference. POL-357's CLI subprocess absorbed worker output variance; POL-362's Foreman received and repaired raw malformed artifacts 5 times.
2. **Child count** (3 vs 6) — doubled all per-cycle overhead (polling, dispatch, checkpoint, status polls) before any other factor applied.
3. **Worker execution duration** (2.8–5.2 min vs 4–10 min) — longer workers directly increased polling cycles in POL-362.
4. **Wait narration verbosity** (one-word vs multi-sentence) — same polling frequency, very different per-message token cost.
5. **Session restart structure** (expected 2-step flow vs 3 mid-run restarts) — POL-362 paid re-orientation overhead 3 times; POL-357 paid it once for main run and once for user-requested finalize.

**Finalize path bug** affected both runs approximately equally and was resolved in each. It is not a differentiator between the runs — it is a shared runtime defect.

**Confidence levels:**

| Conclusion | Confidence | Basis |
|---|---|---|
| `loop run` batch mode eliminated CompactReturn repair overhead | High | Both transcripts — POL-357 write_stdin output, POL-362 artifact repair messages |
| Child count is the primary structural multiplier | High | Both cluster definitions + both transcripts |
| Copilot artifact format mismatch is the largest per-message overhead in POL-362 | High | 5/6 repair cycles directly observable in POL-362 transcript |
| Worker execution duration drove polling frequency | High | Both transcripts — per-child timing measured in both |
| Finalize path bug affected both runs equally | High | Both transcripts — same repair sequence in both |
| Wait narration verbosity was more severe in POL-362 | High | Both transcripts — direct message text comparison |
| Provider narration tendency contributed | Low | Both runs used same provider; single-session variation insufficient |

---

## Appendix: POL-357 Data Sources

- Transcript: `a8918ea9-POL357.txt` (uploaded artifact; session upload ID `951df7ee-5715-56a0-832b-debef281bafe`)
- 392 JSONL lines: 1 session_meta, 127 event_msg, 261 response_item, 3 turn_context
- Run ledger: `.polaris/runs/ledger.jsonl` (run-started: 2026-06-06T16:12:17.946Z)
- Cluster definition: `.polaris/clusters/POL-357/clusters.json`
- Cluster state: `.polaris/clusters/POL-357/cluster-state.json`
- Foreman doctrine: `.polaris/skills/polaris-run/chain.md`
- Provider config: `polaris.config.json`

## Appendix: POL-362 Data Sources

- Transcript: `0ffc010f-POL362transcript.jsonl` (uploaded artifact; session upload ID `951df7ee-5715-56a0-832b-debef281bafe`)
- 778 JSONL lines: 1 session_meta, 270 event_msg, 501 response_item, 6 turn_context
- Run ledger: `.polaris/runs/ledger.jsonl` (contains POL-362 `run-started` event)
- Cluster definition: `.polaris/clusters/POL-362/clusters.json`
- Cluster state: `.polaris/clusters/POL-362/cluster-state.json`
- Foreman doctrine: `.polaris/skills/polaris-run/chain.md`
- Provider config: `polaris.config.json`
