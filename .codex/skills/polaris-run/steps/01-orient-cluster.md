---
name: polaris-run-step-01-orient-cluster
description: Generate run_id, emit run-start telemetry, activate caveman-full if available, fetch the parent cluster from Linear, and restate bounded session context.
---

# Step 01 — Orient cluster

## Purpose

Establish the bounded working context for this session before touching any code.

## Scope declarations

```yaml
allowed_files:
  - .codex/skills/polaris-run/SKILL.md
  - .codex/skills/polaris-run/chain.md
  - .taskchain_artifacts/polaris-run/current-state.json
  - .polaris/clusters/<cluster-id>/clusters.json
allowed_routes:
  - CLAUDE.md
  - docs/Polaris/spec/polaris-implementation-plan.md
  - .codex/skills/polaris-run/chain.md
allowed_skills:
  - caveman
  - repo-analysis
expected_evidence:
  - run_id generated
  - run-start telemetry emitted
  - caveman-full activated if available (or native compact baseline confirmed)
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

0. **Generate `run_id`**:
   - **Fresh runs** — pure local computation with no I/O. Generate `run_id` directly in format `polaris-run-<slug>-<date>-<seq>` (see `chain.md` for format rules).
   - **Resumed runs** — perform I/O first by reading the prior `run_id` and state from `.taskchain_artifacts/polaris-run/current-state.json`, then generate the new `run_id` based on that prior state.

1. **Emit `run-start` telemetry** — first I/O action, before any Linear access or branch work:
   ```bash
   mkdir -p .taskchain_artifacts/polaris-run/runs/<run-id>
   echo '{"event":"run-start","run_id":"<run-id>","prior_run_id":"<prior or null>","timestamp":"<ISO>"}' \
     >> .taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl
   ```
   If this write fails: halt. Do not continue.

2. **Activate caveman-full if available** immediately after run-start emission:
   - Invoke the caveman skill per `linked-skills/caveman.md`.
   - If caveman is installed and activation succeeds: confirm full mode is active, then proceed.
   - If caveman is not installed or activation fails: note the provider status, confirm Polaris-native compact baseline is in effect (per `docs/spec/polaris-compact-contracts.md` §8), and proceed without it.

3. Fetch the **parent issue AND all child issues** from Linear in two sequential calls (get parent, then list children by parent ID).

4. Confirm the cluster is valid and executable:
   - Has children (or is a standalone issue).
   - Not blocked at the parent level.
   - Not Done or Cancelled.
   - Parent is an IMPLEMENT root, not an ANALYZE root. If the parent title starts with `ANALYZE:` or has the `analyze` label, halt before branch work or child dispatch with exactly:
     `polaris-run targets IMPLEMENT parents, not ANALYZE issues. Run polaris-analyze first to create an IMPLEMENT parent.`
   - If ambiguous or not executable: stop and recommend running polaris-analyze first.

5. Check `.polaris/clusters/<cluster-id>/clusters.json` if it exists — it provides execution ordering and dependency metadata produced by polaris-analyze. If absent, derive ordering from child issue numbering.

6. Restate the working context in under 10 bullets:
   - `run_id` and whether this is fresh or resumed
   - Parent issue ID and title
   - Branch name (create or reuse)
   - Total children count
   - Open children (IDs and titles, dependency order)
   - Any blockers visible at this stage
   - Execution boundary (one parent cluster, this session)

7. Do not open source files, read code, or run shell commands beyond telemetry append and the caveman invocation.

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

Emit `step-complete` for `01-orient-cluster` to telemetry JSONL.

## Next step

02-prepare-branch
