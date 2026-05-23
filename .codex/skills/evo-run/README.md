---
name: evo-run
description: Execute governed EVO Linear parent clusters using lean child-by-child execution.
---

# evo-run

Execute one governed EVO Linear parent cluster per fresh session, with bounded child execution inside the cluster.

## Purpose

evo-run is the execution controller for governed EVO clusters. It takes a Linear parent issue, executes its child issues in numeric order, and produces a single draft PR when all children are Done.

The design goal is minimal token waste with full governance: each child is bounded, scoped, and independently verifiable before the session advances.

## Architecture

```text
SKILL.md          Agent entry point — reads chain.md, reads .taskchain_artifacts/evo-run/current-state.json, executes one step at a time
chain.md          Route map — step order, continuation rules, session boundary rules, skill stack policy
.taskchain_artifacts/evo-run/
  current-state.json  Authoritative live state — updated after every step, survives session boundaries
  run-report.md   Generated closeout artifact — written once at completion, not per-step
  runs/           Append-only JSONL telemetry
.evo-run/ (legacy)  Pre-migration artifact path; historical records only; do not write new runs here
steps/
  01–08           Bounded step files — each contains only the instructions for that specific operational step
```

`.taskchain_artifacts/evo-run/` is the canonical artifact location for evo-run. `evo-run` is a governed
repo-level execution entrypoint, so active and resumable state must be easy to
find across Codex, Linear handoffs, and future tracker adapters.

## Traversal model

The agent loads `chain.md` as the route map and executes steps in declared order. It does not load the full workflow into one prompt. Each step file is read only when that step is active. After every step, `.taskchain_artifacts/evo-run/current-state.json` is updated before the next step begins.

The child execution loop (steps 03–07) repeats until one of three exit conditions is reached:

- **All children Done**: child loop exits; session waits for an explicit delivery request.
- **Session stop**: token risk, validation noise, or scope growth triggers a clean halt; the user resumes in a fresh session.
- **Blocked**: a child or blocker condition halts forward execution immediately.

## Artifact state model

`.taskchain_artifacts/evo-run/current-state.json` is the single source of runtime truth within a session. It tracks:

- current parent and branch
- which child is active
- which steps have completed
- last commit hash
- validation status
- next intended step

Between sessions, continuity comes from **Linear state**, **git commits**, **branch state**, and **PR state** — not from session memory. A resumed session re-orients via step 01 and reads Linear fresh.

## Continuation model

Within a session, the agent continues across multiple children by default. A fresh session per child is optional — used only when token risk, validation breadth, log noise, or scope growth makes continuation unsafe.

A fresh session per parent cluster is the hard boundary. Never run two parent clusters in one session.

## User commands

```bash
# Start a fresh cluster session
Use evo-run on EVOC-XXX.

# Resume the same parent cluster after a safe stop
Use evo-run on EVOC-XXX. Continue the cluster from Linear state.

# Execute one child only (safety stop after first child)
Use evo-run on EVOC-XXX. Execute one child only.

# Final delivery after all children are Done
Use evo-run on EVOC-XXX. Finalize delivery, push the branch, and create the draft PR.
```

## What evo-run does not do

- Does not run multiple parent clusters in one session.
- Does not push or create PRs until final delivery is explicitly requested.
- Does not perform broad repo analysis or doctrine traversal.
- Does not re-audit completed children.
- Does not silently expand scope — out-of-scope discoveries become follow-up issues.
- Does not use docs-ingest during execution.
- Does not run evo-plan unless the parent is ambiguous or not executable.
