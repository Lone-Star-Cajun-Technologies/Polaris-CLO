# Foreman Transcript Comparison: POL-357 vs POL-362

**Date:** 2026-06-06  
**Analyst:** claude-sonnet-4-6  
**Transcripts analyzed:**  
- POL-362: `0ffc010f-POL362transcript.jsonl` (910 KB, 778 JSONL lines — fully analyzed)  
- POL-357: `ce34c9e7-POL357transcripts.txt` — **upload contained only a local path reference; transcript not available**

> **Scope limitation:** All POL-357 figures in this report are derived from structural artifacts in the repository (`cluster-state.json`, `ledger.jsonl`, cluster definition). Direct transcript evidence for POL-357 is unavailable. Where POL-357 conclusions depend on inference rather than transcript evidence, this is explicitly marked.

---

## 1. Executive Summary

### Why POL-357 was more efficient (inferred)

POL-357 completed 3 sequentially-dependent children in a well-scoped TypeScript refactoring task with no evidence of worker artifact repair cycles, no finalize path bugs, and a structurally simple cluster. Its Foreman operated in an environment where workers completed cleanly and returned valid artifacts on first pass.

### Why POL-362 was less efficient (evidence-based)

POL-362 ran 6 children implementing novel language adapters (Swift, Kotlin/Java, Dart, Svelte). Every Copilot worker except the first returned a malformed result artifact requiring Foreman-side normalization before `loop continue` would accept the checkpoint. A finalize path bug added 7 additional debugging messages. Long worker execution times — particularly POL-365 which stalled for multiple polling intervals — drove 62 sleep cycles (31 minutes) and 21 status polls. The Foreman narrated each polling interval, adding weight to an already-growing context.

---

## 2. Foreman Behavior Metrics

### POL-362 (transcript evidence)

| Metric | Count | Notes |
|---|---|---|
| Total Foreman messages | 130 | Across 3 invocations |
| Session duration | 46.8 min | 17:56 → 18:43 UTC |
| Time in 30s sleep cycles | 31.0 min (66%) | 62 × `write_stdin(yield_time_ms: 30000)` |
| Distinct `loop status --json` polls | 21 | Explicit status checks via `exec_command` |
| Polling cycle instances (yield → status check) | 43 | Measured from call sequence |
| Worker dispatches | 6 | One per child |
| Worker completions observed | 6 | All successful |
| Worker artifact repair cycles | 5 | POL-367, 366, 365, 364, 363 — every Copilot worker except the first |
| Apply-patch operations | 6 | Artifact normalization + 1 state.json creation |
| Finalize path debugging messages | 7 | M122–M128; `cluster-state.json` vs `current-state.json` contract mismatch |
| Safety-threshold discussions | 2 | M18 (22 files, POL-368), M37 (20 files, POL-367) |
| Session restarts required | 3 | Invocations: M1–M47, M48–M113, M114–M130 |
| Context at turn 1 | 26,700 tokens | Post-bootstrap |
| Context at turn 131 (peak) | 174,493 tokens | 67.5% of 258,400 window |
| Cumulative input tokens | 12,822,162 | All 131 turns |
| Cache hit rate | 97.0% | 12,436,608 / 12,822,162 cached |

### POL-357 (structural inference — no transcript)

| Metric | Value | Basis |
|---|---|---|
| Children | 3 | `clusters.json` |
| Child scope | Bounded TS/JS refactoring | Cluster definition |
| Validation passes | 3/3, first-pass | `cluster-state.json` — no repair evidence |
| Estimated Foreman messages | 50–70 | Proportional to child count; no repair overhead |
| Estimated peak context | 70,000–90,000 tokens | Estimated by scaling; no polling stalls |
| Session invocations | 1 (estimated) | Ledger shows single `run-started` event |

---

## 3. POL-362 Runtime Characteristics

### Child execution timeline

| Child | Dispatch | Checkpoint | Duration | Issues |
|---|---|---|---|---|
| POL-368 | 17:57:22 | 18:04:35 | ~7 min | Clean (auto-dispatched via `loop run`) |
| POL-367 | 18:04:35 | 18:12:30 | ~7 min + 2 min repair | Artifact repair required; initial `loop run` halted with `worker-error` |
| POL-366 | 18:13:35 | 18:19:11 | ~5 min + repair | Validation format repair; `autoDispatch:false` required manual dispatch |
| POL-365 | 18:19:15 | 18:29:13 | ~10 min + repair | Stall period (M73–M83); transient API error; hash resolution + repair |
| POL-364 | 18:29:21 | 18:33:39 | ~4 min + repair | Artifact normalization (pattern now expected) |
| POL-363 | 18:33:44 | 18:38:25 | ~5 min + repair | Artifact normalization; validation output inspection |

### Worker artifact format mismatch

Every Copilot worker except POL-368 returned a result file using a legacy format:

```text
Legacy (rejected):       Accepted:
status: "completed"      status: "done"
short commit hash        full 40-char SHA
validation: { cmd: bool} validation: { passed: ["cmd1", "cmd2"] }
```

`loop continue` rejects checkpoints that do not match the accepted format. The Foreman had to:
1. Read the sealed result file
2. Resolve the full commit SHA (POL-365 required a `git log` lookup)
3. Apply a patch to normalize the artifact
4. Retry `loop continue`

This repair cycle generated 2–7 messages and 3–5 tool calls per child. Across 5 children, artifact repair accounts for approximately **23 Foreman messages** and **~15 tool calls**.

### POL-365 stall period

Between M73 and M83 (18:23 → 18:29, ~6 minutes), the POL-365 Copilot worker was silent. The Foreman polled 5 times, inspected process state, found the worker still alive, and eventually observed recovery from a transient API error. This produced 11 purely diagnostic/polling messages during a period of zero progress.

### Finalize path bug

At M122, `npm run polaris -- finalize run --state-file .polaris/clusters/POL-362/cluster-state.json` failed because the finalizer expected a `completed_children` field found in the compatibility `current-state.json`, not the canonical `cluster-state.json`. The Foreman spent 7 messages (M122–M128) diagnosing the contract, inspecting POL-357's path as a reference, constructing a compatible state.json, and retrying. This is a runtime implementation issue — the finalizer's input contract is inconsistent with the canonical state surface.

### Session restart overhead

The POL-362 run required 3 separate Codex session invocations. Each restart:
- Re-reads the skill chain and bootstrap packet
- Re-orients to runtime state
- Adds ~5 orientation messages to context

Invocation 2 (M48) spent one full message re-confirming runtime state before dispatching. This is expected behavior per the chain, but each restart multiplies boot overhead.

---

## 4. Message Classification (POL-362)

| Category | Count | % | Description |
|---|---|---|---|
| ACTIONABLE | ~28 | 22% | Dispatch, checkpoint, decision, state transition |
| WAIT_NARRATION | ~18 | 14% | Reports waiting only — no new information |
| STATUS_PROGRESS | ~35 | 27% | Worker progress updates (%, file count, heartbeat) |
| REPAIR / DIAGNOSTIC | ~23 | 18% | Artifact repair cycles, path debugging, process probing |
| ORIENT | 5 | 4% | Boot, skill chain read, bootstrap, runtime auth |
| OTHER | ~21 | 16% | Worker narrative, miscellaneous state confirmation |

**Compressible messages** (WAIT_NARRATION + fully redundant STATUS_PROGRESS): ~40–45 messages (~31–35% of total).

### Patterns that recur without adding value

**Pattern 1 — Bare wait narration (18 instances):**
```text
"Still no worker return yet. The parent command is in the adapter-owned
execution phase for POL-368, so I'm continuing to wait." (M8)

"The dispatch is still quiet, so I'm checking runtime status again
for progress or a worker-side blocker before deciding whether to keep
waiting." (M17)

"No compact return yet. The runtime still owns execution,
so I'm polling the active command." (M32)
```
These messages are generated once every 30s sleep cycle when no progress is observed. A strict thin-parent model would emit nothing until a state change occurs.

**Pattern 2 — Redundant progress percentages (10+ instances):**
```text
M28: "POL-367 is progressing: 24%, five files changed, no blocker."
M31: "POL-367 is at 43% with no blocker."
M34: "POL-367 is at 60%, still unblocked."
M37: "POL-367 is at 66%, no blocker."
```
Each `loop status --json` call returns updated progress. The Foreman narrated every status result even when there was no actionable information. This violates the **Forbidden narration** clause in `chain.md` (no "thinking out loud").

**Pattern 3 — Worker file-creation narration (8+ instances):**
```text
M53: "The copilot worker has acknowledged the packet... emitting heartbeats for POL-366."
M54: "The worker has created the Swift adapter and extraction files and is continuing scoped implementation."
M55: "POL-366 now has runtime, index, and fixture test files created."
```
The chain.md explicitly forbids "summarizing code changes made by a worker." These messages narrate implementation details the Foreman should be unaware of.

---

## 5. Root Cause Analysis

### High Confidence

**HC-1: Child count doubled all per-cycle overhead**

POL-362 had 6 children vs POL-357's 3. Each child generates a minimum of:
- 1 dispatch message
- N polling cycles (3–11 per child in POL-362)
- 1 status poll result
- 1 checkpoint message

With 6 children, every per-child overhead metric doubled before any other factor applied. Child count is not itself a compressibility problem, but it is a multiplier on all other inefficiencies.

*Evidence:* `clusters.json` (POL-357: 3 children, POL-362: 6 children). Per-child message distribution from transcript (M6→M22 for POL-368, M22→M46 for POL-367, etc.).

**HC-2: Copilot worker CompactReturn format mismatch drove 5 repair cycles**

5 of 6 Copilot workers returned result artifacts using a legacy schema (`status:"completed"`, short SHA, validation as map). The Polaris runtime's `loop continue` rejected these artifacts, triggering mandatory repair work by the Foreman that was never planned in the session.

This is not a Foreman doctrine problem — the Foreman correctly identified the schema mismatch and repaired it. But the repair itself generated 23 messages and ~15 tool calls that would not exist if workers produced conformant artifacts.

*Evidence:* M41–M45 (POL-367 repair), M62–M63 (POL-366), M86–M88 (POL-365, including hash resolution), M98–M99 (POL-364), M110–M111 (POL-363). Pattern appears in 5 consecutive workers after the first.

**HC-3: Polling frequency produced unnecessary narration**

The Foreman narrated every 30s polling cycle whether or not there was new information. In the long quiet window for POL-367 (M23–M40, ~18 messages over ~7 minutes) and POL-365 (M66–M84, ~19 messages over ~10 minutes), the Foreman generated a message for every poll result including those that returned identical state.

The chain.md's narration suppression rule ("The orchestrator does not narrate implementation details") was partially honored — the Foreman did not write code — but the rule against "thinking out loud" was not consistently enforced. The Foreman narrated its own decision to continue waiting on every cycle.

*Evidence:* M7–M11, M16, M19, M24–M40 (POL-367 polling); M52, M58, M67–M83 (POL-365 polling). Tool call sequence: 62 `write_stdin(30000ms)` + 21 `loop status --json`.

### Medium Confidence

**MC-1: POL-365 worker stall drove 11 extra diagnostic messages**

POL-365 experienced a multi-interval stall around 18:23–18:29 UTC. A transient API error in the Copilot worker caused silence for ~6 minutes. The Foreman produced 11 messages diagnosing whether the worker was stalled vs. slow, probing process state, and ultimately observing recovery. If workers returned progress signals more reliably, this diagnostic overhead would not have occurred.

*Evidence:* M73–M84. Worker eventually recovered (M84: "recovered from a transient API error").

**MC-2: Finalize path bug added 7 debugging messages**

The finalizer accepted `current-state.json` but rejected `cluster-state.json` despite both encoding the same logical state. The Foreman spent 7 messages debugging the contract, referencing POL-357's finalize path as a model, and constructing a compatible handoff file. This is a runtime defect, not a Foreman behavior issue, but it consumed context that a clean finalize would not.

*Evidence:* M122–M128; `finalize --help` call; `rg -n "completed_children"` source inspection; `ls .polaris/clusters/POL-357` reference lookup.

**MC-3: Worker scope drove longer execution times, which drove more polling cycles**

POL-362 children implemented novel language adapters (Swift, Kotlin/Java, Dart, Svelte) requiring new dependencies, new Tree-sitter grammars, and new test infrastructure. POL-357 children performed bounded TypeScript refactoring within an established module. Longer worker execution time directly increases the number of 30s polling cycles and therefore the number of Foreman narration messages.

This is not a direct cause of verbosity, but it is the mechanism by which larger child scope increased Foreman context: longer workers → more polling cycles → more narration.

*Evidence:* POL-365 ran ~10 minutes (M65→M89), POL-367 ran ~7 minutes (M22→M46). Contrast with POL-357's bounded scope in `clusters.json`.

**MC-4: autoDispatch:false required 3-message dispatch sequence instead of 1**

After POL-367's repair and the session restart at M48, the Foreman had to discover the dispatch path manually (M49–M51): first calling `loop resume`, then reading `polaris.config.json` to find the terminal adapter command, then launching `copilot -p ...` directly. This produced 3 messages where a single `loop dispatch` would have sufficed.

*Evidence:* M49 ("Resume refreshed the bootstrap... did not dispatch by itself"), M50 ("autoDispatch:false"), M51 ("I'm launching it as the terminal worker"). POL-368 was dispatched automatically via `loop run`, so no such overhead appeared for the first child.

### Low Confidence

**LC-1: Provider narration tendency**

The Codex/GPT-5 orchestrator may have a higher baseline tendency to narrate intermediate state than a Claude orchestrator would under the same doctrine. Without a Claude-orchestrated run of the same cluster as a control, this cannot be confirmed. The pattern of narrating every poll cycle and every worker progress update is consistent with a provider that prefers to report reasoning rather than suppress it.

*Evidence:* All 18 WAIT_NARRATION messages. Insufficient — no comparative transcript from a Claude orchestrator on an equivalent cluster.

**LC-2: Stale runtime state initialization**

The first 5 Foreman messages were consumed resolving a stale `current-state.json` (still pointing to POL-357). An `npm run polaris -- loop run POL-362` call bootstrapped the correct state. This added ~5 messages that a clean-state invocation would not require.

*Evidence:* M4 ("The live current-state.json is still for POL-357"), M5 ("confirming active ledger is completed POL-357"). Minor impact.

---

## 6. Evidence Table

| Observation | Transcript Evidence | Estimated Impact |
|---|---|---|
| 62 sleep cycles × 30s = 31 min idle | 62 `write_stdin` calls, `yield_time_ms: 30000` (all identical) | Context growth: +~30K tokens in tool call overhead |
| 5/6 Copilot workers produced legacy artifact format | M41–M45, M62–M63, M86–M88, M98–M99, M110–M111 | +23 messages, +~15 tool calls, +~20K tokens |
| Foreman narrated every polling cycle | M7–M11, M16, M19, M24–M40, M52, M58, M66–M83 | +~35 compressible messages |
| Finalize rejected cluster-state.json | M122–M128; `finalize --help`; rg source inspection | +7 messages, +~8 tool calls, +~15K tokens |
| POL-365 stall: 6 min silence | M73–M84 (11 messages); M84 confirms API error recovery | +11 messages, +5 polling cycles |
| autoDispatch:false caused 3-step dispatch | M49–M51 | +2 extra messages per post-repair dispatch |
| Worker narration forbidden by chain.md | M53–M55, M67–M72 (worker file-creation reports) | +8 doctrine-violating messages |
| Session required 3 restarts | `task_started` count = 3 in event log | +~10 orientation messages total |
| Context grew from 26,700 → 174,493 tokens | Token progression in 131 `token_count` events | At end: 67.5% of 258,400 window consumed |
| Progress % narrated on every status call | M28, M31, M34, M37, M75, M92, M95 | +~10 redundant status messages |

---

## 7. Compression Opportunities

### CO-1: Suppress zero-information polling messages

**Current behavior:** The Foreman emits a commentary message on every 30s sleep cycle, even when no state change occurred.

**Target:** Emit a message only when the polling result reveals a state change (progress advance, blocker, or completion). If state is identical to the previous poll, emit nothing.

**Estimated savings:** 15–18 messages per 6-child cluster (based on POL-362 pattern).

**Doctrine change required:** Add to `chain.md` Narration Suppression:
> "Do not narrate wait intervals when no state change has been observed since the previous poll. A message is required only when: (a) dispatch occurs, (b) a state change is observed, (c) a blocker is detected, or (d) a checkpoint is taken."

### CO-2: Suppress intermediate worker progress narration

**Current behavior:** The Foreman narrates `loop status` output (progress %, file counts, no-blocker state) after each status poll.

**Target:** Never narrate intermediate worker progress. If a status poll returns no blocker, emit nothing. If it returns a blocker, emit the blocker immediately.

**Estimated savings:** 10–12 messages per cluster.

**Doctrine change required:** Extend the Forbidden narration list in `chain.md`:
> "Do not narrate intermediate worker progress percentages, file counts, or heartbeat status. These are visible in the runtime telemetry and do not affect orchestration decisions."

### CO-3: Suppress worker implementation narration

**Current behavior:** The Foreman narrates what the worker is doing (file creation, validation steps, commit).

**Target:** The Foreman cannot observe worker implementation — it only observes stdout. Any narration of what the worker is implementing violates the thin-parent boundary.

**Estimated savings:** 8 messages per cluster.

**Doctrine change required:** Strengthen the existing Forbidden narration clause:
> "Do not narrate implementation details. The orchestrator must not describe or summarize worker file creation, edits, test runs, or commit activity. If such content appears in worker stdout, discard it."

### CO-4: Reduce polling frequency for long-running workers

**Current behavior:** The Foreman polls every 30s throughout worker execution, regardless of worker duration pattern.

**Target:** After 3 consecutive no-change polls, extend the sleep interval to 60s. After 6 consecutive no-change polls (indicating a long-running worker), extend to 90s.

**Estimated savings:** 5–8 fewer sleep cycles per long-running worker. For POL-365 (~10 min execution), this would have reduced 20 polls to ~10.

**Implementation required:** Modify the polling loop (or the Foreman's polling behavior instruction) to use backoff when no state change is observed across N consecutive intervals.

### CO-5: Standardize Copilot worker CompactReturn format

**Current behavior:** Copilot workers return `status:"completed"` with a validation map, requiring Foreman-side normalization before `loop continue` will accept the checkpoint.

**Target:** Either (a) update the worker packet to mandate the correct schema, or (b) make `loop continue` tolerant of the legacy format and normalize internally.

**Estimated savings:** 23 Foreman messages and 15 tool calls eliminated entirely.

**Implementation required:** Two options:
- *Option A (preferred):* Update `loop continue` to accept both `status:"completed"` and `status:"done"`, normalize short commit hashes internally, and accept both validation shapes. This removes the repair burden from the Foreman entirely.
- *Option B:* Update the Copilot worker packet instructions to explicitly require `status:"done"`, 40-char SHA, and `validation.passed[]` array format.

### CO-6: Fix finalizer state file contract

**Current behavior:** `finalize run` accepts `current-state.json` but rejects `cluster-state.json`, even though the canonical state surface (per `chain.md`) is the cluster-state path.

**Target:** `finalize run` should accept `cluster-state.json` directly, or auto-discover the correct input from `polaris.config.json`.

**Estimated savings:** 7 Foreman debugging messages eliminated per finalize invocation where the cluster-state.json is the authoritative source.

**Implementation required:** Update `src/finalize` to accept the canonical cluster-state shape, or add a `--cluster-id` flag that auto-resolves the correct input path.

---

## 8. Runtime Improvement Recommendations

### R-1: Make `loop continue` schema-tolerant (addresses CO-5, High priority)

`loop continue` should normalize the legacy CompactReturn schema rather than hard-failing on it. The Foreman's repair work was correct but should not be required. This would eliminate the single largest source of unplanned overhead in POL-362.

### R-2: Add a `--no-narrate-polls` Foreman mode or tighter doctrine (addresses CO-1, CO-2, High priority)

The chain.md narration suppression rules are stated but not mechanically enforced. The Foreman complied with "no inline implementation" but did not comply with "no thinking out loud." A runtime mode that suppresses all commentary-phase messages between dispatch and checkpoint would enforce this structurally rather than relying on model compliance.

### R-3: Implement poll backoff for long-running workers (addresses CO-4, Medium priority)

A Foreman polling loop that backs off from 30s → 60s → 90s intervals after N consecutive no-change status results would reduce total sleep cycle count for workers like POL-365 that run for 8–10 minutes.

### R-4: Fix finalizer state file auto-discovery (addresses CO-6, Medium priority)

The finalizer's input contract should accept the canonical cluster-state path. The workaround of copying state.json from taskchain_artifacts is a fragility the Foreman should not need to discover at runtime.

### R-5: Instrument per-child Foreman token budget (Low priority)

Add a warning threshold to the Foreman when per-child Foreman context exceeds a configurable token count. In POL-362, the average per-child Foreman overhead was ~24,665 tokens (147,793 / 6). If one child drives disproportionate overhead, a token budget alert would surface it before the session approaches the context limit.

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

**POL-357 achieved better Foreman compression primarily because it had 3 children instead of 6, and those workers returned valid result artifacts on first pass — eliminating the repair overhead that dominated POL-362.**

The secondary causes, ranked:
1. Child count halved all per-cycle overhead (polling, dispatch, checkpoint).
2. No worker artifact repairs (vs. 5 repairs in POL-362, each adding 2–7 messages).
3. Likely shorter worker execution times (bounded TS/JS refactoring vs. novel language adapter implementation), reducing polling frequency.
4. No finalize path bug.
5. Presumably no session restart mid-cluster.

**Confidence levels:**

| Conclusion | Confidence | Limiting factor |
|---|---|---|
| Child count is the primary structural multiplier | High | Cluster definitions available for both |
| Copilot artifact format mismatch is the largest per-message overhead | High | 5/6 repair cycles directly observable in POL-362 transcript |
| POL-357 had no artifact repair cycles | Medium | Cluster-state shows clean validations; transcript unavailable to confirm |
| Worker execution time drove polling frequency | Medium | POL-362 timing observable; POL-357 timing not available |
| Finalize path bug was POL-362-specific | Medium | POL-357's cluster-state structure differs (no state.json creation event) |
| Provider narration tendency contributed | Low | No Claude-orchestrated control run available |

---

## Appendix: POL-362 Data Sources

- Transcript: `0ffc010f-POL362transcript.jsonl` (uploaded artifact; session upload ID `951df7ee-5715-56a0-832b-debef281bafe`)
- Run ledger: `.polaris/runs/ledger.jsonl` (contains POL-362 `run-started` event)
- Foreman doctrine: `.polaris/skills/polaris-run/chain.md`
- Provider config: `polaris.config.json`

## Appendix: POL-357 Data Sources (structural only)

- `.polaris/clusters/POL-357/clusters.json` — cluster definition and child scope
- `.polaris/clusters/POL-357/cluster-state.json` — validation results, commits, child states
- `.polaris/runs/ledger.jsonl` — run start timestamp
