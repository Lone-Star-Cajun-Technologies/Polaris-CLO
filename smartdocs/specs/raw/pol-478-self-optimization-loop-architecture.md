---
status: raw
source_issue: POL-478
implements: POL-477
related: POL-462,POL-463,POL-469,POL-470,POL-471,POL-476
source_paths: src/autoresearch/,src/loop/,src/qc/,src/cluster-state/
---

# Self-Optimization Loop (SOL) Architecture

## Version

v0.1 — raw architecture spec

## Purpose

This document defines the Polaris **Self-Optimization Loop (SOL)**: a bounded, evidence-based optimization layer that observes completed runs, evaluates Foreman and worker performance, maintains local historical trends, and emits review-gated recommendations for routing policy and runtime improvements.

SOL is the broader optimization engine. The existing `src/autoresearch` module remains a narrower SOL sub-capability responsible for evidence scoring and proposal routing.

## Scope

- SOL observation, evaluation, optimization, and recommendation phases.
- Boundary between SOL and the Auto Research sub-capability.
- Upstream signal producers: Worker Router and QC.
- Run timing, data flows, deterministic boundaries, and Polaris-repo versus consumer-repo behavior.
- Output locations and review gates. Runtime implementation is out of scope for this document.

## What SOL does

1. **Observes** durable run evidence after a run or cluster completes.
2. **Evaluates** that evidence into normalized performance signals with confidence and skipped-evidence reasons.
3. **Optimizes** by detecting trends, outliers, regressions, and improvement opportunities.
4. **Recommends** review-gated changes to routing policy, provider/model choice, cost/trust thresholds, and Polaris runtime behavior.

SOL never silently mutates provider policy, runtime state, skills, doctrine, source code, or historical run evidence.

## What SOL does not do

- Replace Foreman validation, child selection, or finalize gates.
- Replace Worker Router scheduling decisions.
- Replace QC review or treat QC findings as ground truth.
- Replace Closeout Librarian or other delivery gating.
- Auto-apply proposals.
- Reorder, skip, or redispatch children during an active run.
- Operate outside the dev-gated or operator-triggered timing defined below.

## Architecture phases

### 1. Observation

The observation phase loads completed-run evidence from repo-local artifacts. All inputs are optional unless explicitly required by a specific scorecard; missing evidence reduces confidence rather than blocking scoring.

| Source | Artifact | What it provides |
|---|---|---|
| Run state | `.taskchain_artifacts/polaris-run/current-state.json` | Completed child results, dispatch records, open/closed children, run metadata. |
| Result packets | `.polaris/clusters/<cluster-id>/results/<child-id>-*.json` | `WorkerResultContract`: status, validation, commit, provider, model, role, worker identity. |
| Telemetry | `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl` | Heartbeats, provider selection, fallback, exhaustion, intervention, progress. |
| Cluster state | `.polaris/clusters/<cluster-id>/cluster-state.json` | Validation results, commits, blockers, tracker mutations. |
| Worker Router | `.polaris/clusters/<cluster-id>/router/` or telemetry events | `RouterDecisionEvidence`, candidate scores, rejection reasons, policy rules. |
| QC | `.polaris/clusters/<cluster-id>/qc/` | Normalized findings with severity, category, attribution confidence, provider noise baseline. |
| Run reports | `smartdocs/runtime/run-reports/` or `.polaris/runs/` | Human-readable summaries and delivery context. |

Observation must tolerate missing or partial evidence. Each evaluator records which inputs were present and why any expected signal was skipped.

### 2. Evaluation

Evaluation turns observed evidence into machine-readable scorecards. Each scorecard exposes:

- `subject`: Foreman, worker, provider, model, routing policy, route, task type, role, or risk level.
- `window`: run id, cluster id, time window, repo, route, task type, role, provider, model.
- `raw_metrics`: token counts, elapsed time, validation outcome, QC findings, fallback events, intervention events, retries, out-of-scope evidence, completion status.
- `subscores`: normalized dimensions such as quality, efficiency, reliability, scope fidelity, recovery, and suitability.
- `aggregate_score`: weighted result with an explicit formula version.
- `confidence`: `high`, `medium`, `low`, or `unavailable` with reasons.
- `source_refs`: paths to run state, telemetry, result packets, QC artifacts, cluster state, and run reports.
- `recommendation_inputs`: facts that may feed Worker Router advice without applying changes.

Foreman score dimensions include:

- token usage and bootstrap context size;
- runtime duration and elapsed child timing;
- user intervention frequency;
- unnecessary pre-analysis or simulation when detectable;
- dependency handling and blocked-child discipline;
- worker dispatch accuracy and redispatch behavior;
- evidence validation quality;
- scope control;
- successful cluster completion;
- recovery from worker failure.

Worker score dimensions include:

- token usage;
- runtime duration;
- validation result;
- QC severity and attribution confidence;
- repair iterations required;
- scope adherence and out-of-scope files;
- acceptance criteria success;
- first-pass success.

QC findings must be weighted by severity and attribution confidence, not raw counts. Provider-level noise baselines prevent over-penalizing workers for noisy providers.

### 3. Optimization

Optimization compares scorecards across historical windows to detect:

- regressions in quality, efficiency, or reliability;
- provider/model misalignment for specific roles or routes;
- recurring router exhaustion reasons;
- out-of-scope work patterns;
- token-inefficient task types;
- recovery-loop hotspots.

Historical snapshots are stored locally under `.polaris/sol/history/` as normalized, auditable records grouped by repo, route, task type, role, risk, provider, model, worker identity, and time window.

Optimization outputs are advisory. They feed recommendation generation; they do not directly mutate router thresholds or provider policy.

### 4. Recommendation

Recommendations are review-gated proposals. They are filed as tracker issues (or equivalent repo-local review artifacts) for human review. The existing `src/autoresearch/proposal.ts` and `src/autoresearch/routing.ts` continue to own this step under SOL.

Recommendation categories include:

- routing policy adjustments;
- provider/model role suitability changes;
- trust/cost threshold tuning;
- artifact or route-cognition fixes;
- Polaris runtime improvements (Polaris repo only).

Every recommendation must cite source evidence, confidence, and the expected review gate.

## Auto Research as a SOL sub-capability

`src/autoresearch` is the evidence-scoring and proposal-routing sub-capability inside SOL. Its responsibilities are:

- `score.ts`: load run artifacts, evaluate binary gates, summarize router outcomes from telemetry, and emit a `DiagnosisReport`.
- `gates.ts`: define and run `ALL_GATES` over run evidence.
- `proposal.ts`: map failed gates to reviewable fix zones.
- `routing.ts`: file proposals as tracker issues for human review, never auto-apply.
- `dev-gate.ts`: enforce that autoresearch commands run only in Polaris development context.

SOL adds the broader framing: observation orchestration, evaluation normalization, historical storage, trend optimization, and cross-subsystem recommendation synthesis. Auto Research continues to execute the scoring and proposal steps.

## Upstream signal producers

SOL consumes signals from upstream systems it does not own:

- **Worker Router** (`src/loop/router/`): produces `RouterDecisionEvidence`, provider selection, fallback, and exhaustion telemetry. SOL scores these outcomes; it does not replace router scheduling.
- **QC** (`src/qc/`): produces normalized findings with severity and attribution. SOL treats QC as a noisy advisory input; it does not invoke QC providers or block children on QC findings alone.
- **Loop / Parent** (`src/loop/`): emits telemetry events that SOL aggregates.
- **Cluster state** (`src/cluster-state/`): stores validation results, commits, blockers, and tracker mutations.

SOL is a downstream consumer and recommendation producer. Upstream systems retain their existing responsibilities.

## Run timing

| Timing | Behavior |
|---|---|
| On demand | Always supported for a specific run or cluster. |
| Cluster closeout | Safe point for scoring completed child evidence before or near delivery. |
| PR closeout | Useful when QC providers require PR-level review data. |
| Session start | Advisory only; historical recommendations may inform routing policy but must not rewrite current state or past evidence. |
| During active runs | SOL does not observe or mutate an in-flight run. It operates on completed evidence. |

## Data flows

```
┌─────────────────────────────────────────────────────────────────┐
│                         Observation                             │
│  run state ──▶ result packets ──▶ telemetry ──▶ cluster state   │
│         QC artifacts ──▶ router evidence                          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        Evaluation                               │
│  scorecards (Foreman / worker / provider / model / routing)     │
│  confidence + skipped-evidence reasons                          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Optimization                              │
│  historical snapshots + trend detection + outlier analysis      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Recommendation                             │
│  review-gated proposals ──▶ tracker issues / review artifacts   │
└─────────────────────────────────────────────────────────────────┘
```

## Artifact locations

| Artifact | Location | Format |
|---|---|---|
| Evaluations | `.polaris/sol/evaluations/<run-id>.json` | machine-readable |
| Scorecards | `.polaris/sol/scorecards/<scope>/<key>.json` | machine-readable |
| History snapshots | `.polaris/sol/history/<window>.jsonl` | machine-readable |
| Recommendations | `.polaris/sol/recommendations/<generated-at>.json` | machine-readable |
| Human-readable reports | `smartdocs/reports/sol/` | Markdown |

Reports summarize trends, outliers, confidence, and recommendations with links back to source evidence.

## Deterministic boundaries

- SOL operates on completed, immutable run evidence.
- SOL outputs are reproducible from the same inputs: scorecards reference source artifacts and formula versions.
- SOL does not rewrite historical run evidence or telemetry.
- SOL recommendations are review-gated; no runtime mutation occurs without an explicit downstream action.
- SOL must not introduce non-deterministic external dependencies (remote analytics, provider-specific scoring models) unless a future explicit design opts in.

## Polaris-repo versus consumer-repo behavior

| Aspect | Polaris repo | Consumer repo |
|---|---|---|
| Purpose | Optimize Polaris runtime, routing, provider policy, and worker quality. | Optimize routing, orchestration, worker/provider choice, and performance for that repo. |
| Proposals | May include Polaris runtime improvements and internal tooling changes. | Limited to routing, orchestration, worker/provider, and performance recommendations. |
| Auto Research commands | Dev-gated; available in Polaris development context. | Dev-gated; blocked by `assertPolarisDevContext()`. |
| Historical storage | Local under `.polaris/sol/`. | Local under `.polaris/sol/`. |
| Tracker integration | Filed as issues via configured tracker adapter. | Filed as issues via configured tracker adapter, if any. |
| Default mode | Advisory and review-gated. | Advisory and review-gated. |

## Command surface intent

The preferred future command surface is `polaris sol ...`. The existing `polaris autoresearch ...` command remains as a compatibility alias. No command rename is required by this document.

## Relationship to other specs

- `smartdocs/specs/active/worker-router-architecture.md` §3.9 defines SOL telemetry emitted by the router.
- `smartdocs/specs/active/quality-control-architecture.md` §5.6 defines QC feedback boundaries for SOL.
- `smartdocs/specs/active/autoresearch-role-evidence-contract.md` defines the result contract that SOL observation loads.
- `smartdocs/raw/analysis/pol-462-self-optimization-loop-analysis.md` contains the preceding analysis.

## Acceptance criteria

- [x] SOL architecture defines observation, evaluation, optimization, and recommendation phases.
- [x] Auto Research is documented as a SOL sub-capability rather than the parent concept.
- [x] Boundaries state that SOL recommends and routes review-gated work, not silent runtime mutation.
- [x] Worker Router and QC are named as upstream signal producers, not SOL-owned replacements.
- [x] Run timing, data flows, deterministic boundaries, and Polaris-repo versus consumer-repo behavior are documented.
