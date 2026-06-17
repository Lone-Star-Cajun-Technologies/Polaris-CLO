---
name: polaris-run-step-01-orient-cluster
description: Query runtime state, generate run_id if needed, emit run-start telemetry, fetch the parent cluster from Linear, and restate bounded session context.
---

# Step 01 — Orient cluster

## Purpose

Establish the bounded working context for this session before touching any code. Runtime state is authoritative — query it first, do not reconstruct it from chat reasoning.

## Scope declarations

```yaml
allowed_files:
  - .polaris/skills/polaris-run/SKILL.md
  - .polaris/skills/polaris-run/chain.md
  - .taskchain_artifacts/polaris-run/current-state.json
  - .polaris/clusters/<cluster-id>/clusters.json
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .polaris/skills/polaris-run/chain.md
allowed_skills:
  - repo-analysis
expected_evidence:
  - runtime state queried via polaris loop status
  - run_id generated or read from prior state
  - run-start telemetry emitted
  - Linear parent and children fetched
  - cluster is valid and executable
  - bounded session context restated
stop_rules:
  - run-start telemetry write fails
  - parent issue missing or inaccessible
  - parent or selected child is blocked
  - cluster has no children and issue is not standalone
```

## Actions

0. **Query runtime state**:
   Run `polaris loop status` to check for existing session state.
   - **Follow-up run** (state exists and is active for this cluster): read `cluster_id` and step context from runtime output. Mint a new `run_id` in `polaris-run-<slug>-<date>-<seq>` format (see `chain.md` for format rules) — do not reuse the prior `run_id`. Set `related_run_id` to the prior `run_id` read from runtime output. Runtime state is authoritative — do not infer session context from chat history.
   - **Fresh run** (no state file, or state belongs to a different cluster): generate new `run_id` in format `polaris-run-<slug>-<date>-<seq>` (see `chain.md` for format rules). `related_run_id` is `null`.

1. **Emit `run-start` telemetry** — first write action, before any Linear access or branch work:
   ```bash
   mkdir -p .taskchain_artifacts/polaris-run/runs/<run-id>
   echo '{"event":"run-start","run_id":"<run-id>","prior_run_id":"<prior or null>","timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl
   ```
   No runtime CLI command exists for run-start telemetry; direct file append is the standard path.
   If this write fails: halt. Do not continue.

2. Fetch the **parent issue AND all child issues** from Linear in two sequential calls (get parent, then list children by parent ID).

3. Confirm the cluster is valid and executable:
   - Has children (or is a standalone issue).
   - Not blocked at the parent level.
   - Not Done or Cancelled.
   - Parent is an IMPLEMENT root, not an ANALYZE root. If the parent title starts with `ANALYZE:` or has the `analyze` label, halt before branch work or child dispatch with exactly:
     `polaris-run targets IMPLEMENT parents, not ANALYZE issues. Run polaris-analyze first to create an IMPLEMENT parent.`
   - If ambiguous or not executable: stop and recommend running polaris-analyze first.

4. Check `.polaris/clusters/<cluster-id>/clusters.json` if it exists — it provides execution ordering and dependency metadata produced by polaris-analyze. If absent, use the child issue ordering from Linear as the fallback (see step 03).

5. Restate the working context in under 10 bullets:
   - `run_id` and whether this is fresh or resumed
   - Parent issue ID and title
   - Branch name (create or reuse)
   - Total children count
   - Open children (IDs and titles, dependency order)
   - Any blockers visible at this stage
   - Execution boundary (one parent cluster, this session)

6. Invoke `polaris loop status` to confirm runtime state is consistent before advancing to the next step.

## Artifact update

Update `.taskchain_artifacts/polaris-run/current-state.json`:

- `run_id: <generated>`
- `related_run_id: <prior run_id or null>`
- `cluster_id: <parent issue ID>`
- `skill: polaris-run`
- `artifact_dir: ".taskchain_artifacts/polaris-run"`
- `status: orienting`
- `current_step_id: 01-orient-cluster`
- `updated_at: <timestamp>`

Do not emit per-step `step-complete` telemetry. Telemetry is checkpoint-only (`run-start`, `child-dispatched`, child completion/checkpoint events, session end, and blocker/state-repair events).

## Next step

02-prepare-branch
