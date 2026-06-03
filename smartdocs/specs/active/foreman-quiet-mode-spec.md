---
kind: spec
status: active
source: closeout-librarian-runtime
created: 2026-06-03
depends_on:
  - foreman-worker-architecture.md
source_paths:
  - .polaris/roles/foreman.md
  - .polaris/skills/polaris-run/chain.md
related:
  - pol-288-foreman-worker-drift-postmortem.md
---

# Foreman Quiet Mode Specification

**Status:** Authoritative spec
**Created:** 2026-06-03
**Evidence:** polaris-run-pol-283-2026-06-02-002 (POL-288 postmortem)

---

## 1. Problem Statement

The POL-288 postmortem confirmed that the Foreman in polaris-run-pol-283-2026-06-02-002
consumed **21,772,416 cached tokens** by observing and narrating worker activity. This
violated the thin-parent architecture, burned unnecessary tokens, and created conditions
for Foreman interference in worker execution.

Specific observed violations:
- Foreman narrated worker file edits in real-time ("Copilot is now inspecting…")
- Foreman read worker transcript to detect scope violations (rather than using sealed result)
- Foreman performed 4 live repair cycles instead of escalating
- Foreman injected guard instructions into worker prompts mid-execution

These behaviors are prohibited by the thin-parent model but not yet enforced by the
runtime. This spec defines the quiet mode requirement and enforcement strategy.

---

## 2. Quiet Mode Definition

**Quiet mode is the default Foreman operating mode.**

In quiet mode, the Foreman's context window receives only:
1. The packet ID and child ID (before dispatch)
2. The CompactReturn JSON (after dispatch completes)
3. Escalation events (blocked/failed conditions only)

In quiet mode, the Foreman's user-facing output is minimal:

```text
Dispatching     ← dispatching a child
Waiting         ← waiting for worker
Checkpointing   ← running loop continue
Librarian running  ← closeout librarian dispatched
Finalizing      ← running polaris finalize
Done            ← cluster complete
```

Nothing else during normal execution.

---

## 3. Forbidden Narration

The Foreman MUST NOT output any of the following during normal (non-escalation) execution:

- Worker progress summaries ("The worker is currently…")
- Code change descriptions ("The worker modified X to do Y…")
- Implementation detail explanations
- File-by-file change narration
- Test result summaries from worker output
- Speculation about why a worker is doing something
- Any form of "thinking out loud" about the repository

**Rationale:** Worker execution detail is not Foreman input. The CHECKPOINT gate explicitly
discards all worker output except the CompactReturn. Narrating discarded content violates
the gate semantics.

---

## 4. Escalation Exception

The Foreman becomes verbose ONLY when user action is required.

### 4.1 Escalation Format

When an issue requires operator input:

```text
Issue: <clear description of the problem>

Options:
1. <option 1>
2. <option 2>
3. <option 3>
(4. Pause)

How would you like to proceed?
```

### 4.2 Escalation Triggers

| Condition | Escalation Required |
|---|---|
| Worker heartbeat expired (>120s) | Yes |
| Worker exit_code !== 0 | Yes |
| Worker scope violation detected | Yes |
| Closeout Librarian status "blocked" | Yes |
| Closeout Librarian status "failure" | Yes |
| Closeout Librarian timeout | Yes |
| Runtime state corruption detected | Yes |
| Budget exhausted | Yes |
| Bootstrap seal failure | Yes |

### 4.3 Post-Escalation

After the operator responds, the Foreman returns to quiet mode.
The Foreman does NOT continue narrating implementation activity after an escalation is resolved.

---

## 5. Implementation Paths

### 5.1 Instruction-Level (Implemented in this spec)

Updated in `.polaris/roles/foreman.md`:
- Explicit prohibition on narrating worker activity
- Explicit quiet mode output examples
- Escalation format template

Updated in `.polaris/skills/polaris-run/chain.md`:
- "Narration Suppression" section
- CHECKPOINT gate explicit wording

### 5.2 Adapter-Level (Enforcement, Future)

The dispatch adapter (agent-subtask) should return only the CompactReturn JSON to the
Foreman session. Worker session context (full tool-call history) is discarded after
CompactReturn extraction.

Current gap: `stdio: "inherit"` in terminal-cli adapter merges worker stdout into the
Foreman's process. This must be replaced with CompactReturn-only extraction.

Implementation target: `src/loop/adapters/terminal-cli.ts` — replace `stdio: "inherit"`
with CompactReturn extraction mode.

### 5.3 Telemetry Gate (Future)

Add `foreman-context-snapshot` event at CHECKPOINT:
```json
{
  "event": "foreman-context-snapshot",
  "run_id": "...",
  "child_id": "...",
  "approximate_message_count": <n>,
  "timestamp": "..."
}
```

This enables detection of context runaway in future runs.

---

## 6. Watch Mode (Opt-In)

For debugging, an operator may request watch mode:
```bash
polaris loop run --watch
```

In watch mode, the Foreman receives a sanitized stream of worker-progress events
(not raw worker output). The Foreman may display these to the operator but must NOT
use them for implementation decisions.

Watch mode is not the default. It must be explicitly requested.

---

## 7. Enforcement Summary

| Mechanism | Level | Status |
|---|---|---|
| Role file prohibition | Instruction | Implemented |
| chain.md narration suppression | Instruction | Implemented |
| CHECKPOINT gate (chain.md) | Instruction | Implemented |
| Adapter output filtering | Runtime enforcement | Future |
| Context snapshot telemetry | Observability | Future |
| Watch mode opt-in | Runtime enforcement | Future |
