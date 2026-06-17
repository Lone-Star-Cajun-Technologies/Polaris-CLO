---
name: docs-review-chain
description: Route map for docs-review — step order, stop conditions, output contract, and decision protocol.
---

# docs-review chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query `smartdocs/raw/_triage-queue.json` before acting. Do not infer queue state from conversation context.

## Decision protocol

For each flagged packet you evaluate:

1. Read the source document at `sourcePath`
2. Consider the flag metadata: `triageFlag`, `staleSymbols`, `authorityRisk`, `reasoning`
3. Apply this decision rubric:
   - **approve**: doc content is still valid doctrine; stale symbols are incidental (generic English words, external brand names, or aspirational references that don't affect correctness)
   - **reject**: doc is clearly outdated, contradicted by current code, or describes systems that no longer exist
   - **defer**: cannot determine from doc content alone — needs human review

4. Record your decision by editing `_triage-queue.json` directly: set `reviewDecision` to `"approve"`, `"reject"`, or `"defer"`, and set `reviewedAt` to the current ISO timestamp and `reviewedBy` to `"docs-review-agent"`.

## Output contract

All decision output written to `smartdocs/raw/`:

| File | Purpose |
|------|---------|
| `_triage-queue.json` | Updated with `reviewDecision` fields — source of truth for ingest |

## Step traversal order

```text
01-load-queue        ← read _triage-queue.json; count pending items; emit run-start telemetry
02-review-packets    ← for each pending packet: read doc → evaluate → record decision
03-apply-decisions   ← run polaris docs promote for approved packets; run polaris doctrine deprecate for rejected packets
04-hand-off          ← report decision summary (approved / rejected / deferred); emit triage-review-complete telemetry
```

## Stop conditions

**Step 01:**
- `_triage-queue.json` not found → halt: "Run docs-triage first to generate the triage queue"
- Zero pending items → report "Nothing to review — all decisions already recorded" and stop

**Step 02:**
- If a document at `sourcePath` cannot be read → record `defer` and log the path
- Process all packets before moving to step 03 — do not apply decisions mid-loop

**Step 03:**
- If no packets were approved or rejected → skip, report counts only
- For approved packets: call `polaris docs promote <path>` for each (requires `docs-promote` skill authority if conflicts found)
- For rejected packets: call `polaris doctrine deprecate <path>` for each
- Error on apply → report the error; do not retry automatically

## Run ID format

Format: `docs-review-<date>-<seq>`
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `docs-review-2026-06-14-001`

## Telemetry

Telemetry file: `.taskchain_artifacts/docs-review/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Trigger |
|-------|---------|
| `run-start` | Begin step 01 |
| `step-complete` | End of every step |
| `review-complete` | All packets evaluated |
| `apply-complete` | Ingest finished |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Execution reporting

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <outputs written> or none
Validated: <checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full:
- Decision counts (approved / rejected / deferred) after step 02
- Any packets that could not be read (defaulted to defer)
- Ingest results after step 03
