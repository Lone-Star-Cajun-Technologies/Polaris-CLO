---
name: polaris-analyze-step-01-orient-cluster
description: Write session-type, read chain.yaml, initialize or resume state, and confirm the first open analyze child.
---

# Step 01 — Orient cluster

## Purpose

Establish session type and cluster shape before any analysis work begins.

## Scope declarations

```yaml
allowed_files:
  - .polaris/session-type
  - .polaris/clusters/<cluster-id>/chain.yaml
  - .polaris/runs/current-state.json
expected_evidence:
  - session-type written as "analyze"
  - chain.yaml read and cluster children confirmed
  - all children verified as session_type: analyze (or mixed with boundary noted)
  - current-state.json initialized (first session) or verified (resume)
  - feature branch created or confirmed
  - next open child identified
stop_rules:
  - chain.yaml missing or malformed
  - current-state.json schema invalid on resume
  - branch cannot be created or verified
```

## Actions

### First session

0. **Generate `run_id`** — pure local computation, no I/O:
   - Format: `polaris-analyze-<slug>-<date>-<seq>` (see `chain.md` for format rules)
   - Emit `run-start` to the telemetry file as the very first I/O action:
     ```
     mkdir -p .taskchain_artifacts/polaris-analyze/runs/<run-id>
     echo '{"event":"run-start","run_id":"<run-id>","timestamp":"<ISO>"}' \
       >> .taskchain_artifacts/polaris-analyze/runs/<run-id>/telemetry.jsonl
     ```
   - If this write fails: halt. Do not access Linear or touch the branch.

1. Write `.polaris/session-type`:
   ```
   echo "analyze" > .polaris/session-type
   ```
2. Determine the `cluster-id` from the user prompt.
3. Read `.polaris/clusters/<cluster-id>/chain.yaml`.
   - If missing: halt. Report "chain.yaml not found at `.polaris/clusters/<cluster-id>/chain.yaml` — create it before running polaris-analyze. See `.polaris/clusters/chain-yaml-format.md`."
4. Note which children are `session_type: analyze` vs `implement`. Analyze children run first; implement children are a boundary event.
5. Fetch the cluster's Linear parent issue to get `gitBranchName`.
6. Create the feature branch: `git checkout -b <gitBranchName> main`.
7. Initialize `.polaris/runs/current-state.json` from chain.yaml:
   - `run_id`: the generated run_id from action 0
   - `cluster_id`, `skill: polaris-analyze`, `session_type: analyze`, `status: ready`
   - `artifact_dir: ".taskchain_artifacts/polaris-analyze"`
   - `open_children`: analyze children in dependency order
   - `completed_children: []`
   - `active_child: ""`
   - `context_budget.children_completed: 0`
8. Run `polaris loop status` to confirm the first open child.

### Resume session

0. **Generate a new `run_id`** and emit `run-start` with the prior run referenced:
   ```
   mkdir -p .taskchain_artifacts/polaris-analyze/runs/<new-run-id>
   echo '{"event":"run-start","run_id":"<new-run-id>","prior_run_id":"<prior-run-id>","timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/polaris-analyze/runs/<new-run-id>/telemetry.jsonl
   ```
   The prior `run_id` comes from `current-state.json` before overwriting it.
1. Write `.polaris/session-type` (re-assert on each resume):
   ```
   echo "analyze" > .polaris/session-type
   ```
2. Run `polaris loop resume` — verifies state SHA and loads the bootstrap packet.
3. If SHA mismatch: halt. Report "state SHA mismatch — verify `.polaris/runs/current-state.json` before resuming."
4. Update `current-state.json` with the new `run_id`.
5. Run `polaris loop status` to confirm the next open child.

## Artifact update

After completing, `.polaris/runs/current-state.json` must have:

- `status: ready`
- `skill: polaris-analyze`
- `session_type: analyze`
- `open_children` populated with analyze children

## Next step

02-select-child
