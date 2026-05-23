---
name: polaris-run-step-01-orient-cluster
description: Read chain.yaml, initialize or resume state, create or verify the feature branch, and confirm the first open child.
---

# Step 01 — Orient cluster

## Purpose

Establish the cluster shape and session state before any implementation work begins.

## Scope declarations

```yaml
allowed_files:
  - .polaris/clusters/<cluster-id>/chain.yaml
  - .polaris/runs/current-state.json
expected_evidence:
  - chain.yaml read and cluster children confirmed
  - current-state.json initialized (first session) or verified (resume)
  - feature branch created or confirmed
  - next open child identified via polaris loop status
stop_rules:
  - chain.yaml missing or malformed
  - any child has session_type: analyze (run polaris-analyze first)
  - current-state.json schema invalid on resume
  - branch cannot be created or verified
```

## Actions

### First session

0. **Generate `run_id`** — pure local computation, no I/O:
   - Format: `polaris-run-<slug>-<date>-<seq>` (see `chain.md` for format rules)
   - Emit `run-start` to the telemetry file as the very first I/O action:
     ```
     mkdir -p .taskchain_artifacts/polaris-run/runs/<run-id>
     echo '{"event":"run-start","run_id":"<run-id>","timestamp":"<ISO>"}' \
       >> .taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl
     ```
   - If this write fails: halt. Do not access Linear or touch the branch.

1. Determine the `cluster-id` from the user prompt (the Linear parent issue ID, e.g. `POL-5`).
2. Read `.polaris/clusters/<cluster-id>/chain.yaml`.
   - If missing: halt. Report "chain.yaml not found at `.polaris/clusters/<cluster-id>/chain.yaml` — create it before running polaris-run. See `.polaris/clusters/chain-yaml-format.md`."
3. Verify all children have `session_type: implement`. If any are `session_type: analyze`: halt. Report "analyze children present — run polaris-analyze first to cross the boundary."
4. Fetch the cluster's Linear parent issue to get `gitBranchName`.
5. Create the feature branch: `git checkout -b <gitBranchName> main`.
6. Initialize `.polaris/runs/current-state.json` from chain.yaml (see schema in `docs/Polaris/spec/current-state-schema.md`):
   - `run_id`: the generated run_id from action 0
   - `cluster_id`, `skill: polaris-run`, `status: ready`
   - `artifact_dir: ".taskchain_artifacts/polaris-run"`
   - `open_children`: all children in dependency order
   - `completed_children: []`
   - `active_child: ""`
   - `context_budget.children_completed: 0`
7. Run `polaris loop status` to print the first open child.

### Resume session

0. **Generate a new `run_id`** and emit `run-start` with the prior run referenced:
   ```
   mkdir -p .taskchain_artifacts/polaris-run/runs/<new-run-id>
   echo '{"event":"run-start","run_id":"<new-run-id>","prior_run_id":"<prior-run-id>","timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/polaris-run/runs/<new-run-id>/telemetry.jsonl
   ```
   The prior `run_id` comes from `current-state.json` before overwriting it.
1. Run `polaris loop resume` — verifies state SHA and loads the bootstrap packet.
2. If SHA mismatch: halt. Report "state SHA mismatch — verify `.polaris/runs/current-state.json` before resuming."
3. Update `current-state.json` with the new `run_id`.
4. Run `polaris loop status` to confirm the next open child.

## Artifact update

After completing, `.polaris/runs/current-state.json` must have:

- `status: ready`
- `skill: polaris-run`
- `open_children` populated
- `completed_children` set (empty for first session, existing for resume)

## Next step

02-select-child
