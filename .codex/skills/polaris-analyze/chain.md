---
name: polaris-analyze-chain
description: Route map for polaris-analyze — step order, stop conditions, analyze-only boundary enforcement, and artifact requirements.
---

# polaris-analyze chain

## Authority

**Polaris runtime state is authoritative. Chat reasoning is not authoritative.**

Query runtime state before acting. Do not infer analysis scope or prior progress from conversation context.

## CLI

Always use the repo-local Polaris CLI:

```
npm run polaris -- <command>
```

Never assume a globally linked `polaris` command exists.

## Step traversal order

```text
01-fetch-and-orient      ← parallel: Linear fetch + repo-analysis provider check + run-start telemetry
02-map-affected-code     ← targeted repo-analysis inspection (provider or fallback)
03-assess-issue          ← outcome classification
04-blocker-check         ← STOP if blocked or non-executable
05-create-cluster-plan   ← create tracker children + local clusters.json
06-final-report          ← terminal step
```

## Stop conditions

**Step 04 (blocker check):**
Stop immediately if the issue is blocked or assessment outcome is not `needs-cluster-plan`. Do not advance to step 05.

**Any step:**
Stop if:
- Implementation execution is attempted (scope violation — halt and report).
- Canonical doctrine conflict cannot be resolved without user input.
- HIGH or CRITICAL risk identified by repo-analysis provider without a clear resolution path.
- Parent issue is already Done or Cancelled.

## Analyze-only boundary

polaris-analyze is a read-and-plan skill. It never executes implementation work.

The boundary is enforced by this skill — not by the Polaris runtime — because analyze sessions do not call `polaris loop continue`.

If a step produces source code changes, halts on a `src/` file edit, or attempts to push or PR: that is a scope violation. Halt immediately, report the violation, and do not continue.

## Run ID format

Format: `polaris-analyze-<slug>-<date>-<seq>`
- `<slug>`: 2–4 lowercase hyphenated words from the issue title. No Linear IDs.
- `<date>`: `YYYY-MM-DD`
- `<seq>`: zero-padded sequential number per day (`001`, `002`, …)

Example: `polaris-analyze-local-instructions-2026-05-23-001`

## Telemetry

Telemetry file: `.taskchain_artifacts/polaris-analyze/runs/<run-id>/telemetry.jsonl` (append-only).

| Event | Emitted by | Step |
|---|---|---|
| `run-start` | agent | 01 — before any Linear access |
| `step-complete` | agent | end of every step |
| `loop-aborted` | `npm run polaris -- loop abort` | any blocker halt |

Required fields on every event: `event`, `run_id`, `timestamp`.

## Artifact authority

`.taskchain_artifacts/polaris-analyze/current-state.json` is the sole authoritative live state surface.

- Update after every completed step before advancing.
- If the update fails: stop and report the persistence failure.

## Linked-skill invocation boundaries

| Skill | Allowed steps | Condition |
|---|---|---|
| caveman | session start | optional; explicitly enabled runs only — detection is not activation |
| repo-analysis | 01, 02 | targeted lookup only; conditional on provider availability |

Detection is not activation. Only activate Caveman if explicitly enabled for the current run via config or invocation flag. If not explicitly enabled, Polaris-native compact is the required baseline (per `docs/spec/polaris-compact-contracts.md` §8); confirm provider status and proceed. If Caveman is explicitly enabled, activate in lite mode per `linked-skills/caveman.md`.

After each completed step, emit a checkpoint:

```text
**[step-name]** done | blocked | needs-input
Changed: <Linear issues / docs created or updated> or none
Validated: <checks passed> or none
Blockers: none | <explicit blocker>
```

### Never compressed

Always write in full regardless of caveman mode:
- Child issue bodies and cluster plans (generated planning artifacts)
- Blocker reports and unblock conditions
- Doctrine conflict findings
- HIGH or CRITICAL repo-analysis provider risk findings
- Final report (step 06)
