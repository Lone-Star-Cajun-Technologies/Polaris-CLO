---
kind: architecture
status: raw
source: POL-486
implements: POL-484
related: smartdocs/specs/raw/pol-478-self-optimization-loop-architecture.md,smartdocs/specs/active/quality-control-architecture.md,smartdocs/specs/active/worker-router-architecture.md
source_paths: src/autoresearch/sol-report.ts,src/autoresearch/sol-scorer.ts,src/autoresearch/sol-recommendations.ts,src/autoresearch/sol-history.ts,src/cli/autoresearch.ts
---

# SOL Evaluation Report Architecture

## Purpose

This document defines the Self-Optimization Loop (SOL) evaluation report layer: the artifact classes, report taxonomy, raw-metric preservation rules, and non-mutating boundaries that sit between raw run telemetry and review-gated routing recommendations.

## Scope

- Machine-readable and human-readable SOL report artifact classes.
- Report taxonomy: Foreman, worker, provider, model, routing, token efficiency, QC, intervention, and recommendation reports.
- Raw metric retention versus aggregate scorecard responsibilities.
- Artifact locations under `.polaris/sol/` and `smartdocs/reports/sol/`.
- Boundaries that prevent reports from silently mutating runtime behavior.

Report generators are out of scope for this document; implementation children will build them.

## Artifact classes

### Machine-readable artifacts

| Artifact | Producer | Contents |
|---|---|---|
| `RunEvaluation` | `src/autoresearch/sol-scorer.ts` (`computeSolScoreReport`) | Per-run Foreman and worker dimension scores, composite scores, confidence, and `source_refs`. |
| `Scorecard` | SOL scorecard generator (future) | Per-scope normalized scorecards for a single subject (provider, model, route, task type, role, risk tier). |
| `HistorySnapshot` | `src/autoresearch/sol-history.ts` (`appendSnapshot`) | Append-only JSONL line containing a full `SolScoreReport`, grouping keys, and worker IDs. |
| `AggregateReport` | `src/autoresearch/sol-report.ts` (`generateReport`) | Grouped summaries (`SolGroupSummary`) across history snapshots by repo, route, task type, role, risk, provider, model, worker, run, or time window. |
| `RecommendationsReport` | `src/autoresearch/sol-recommendations.ts` (`generateRecommendations`) | Advisory recommendations with evidence references, affected routing dimensions, and proposed policy actions. |

### Human-readable artifacts

| Artifact | Producer | Contents |
|---|---|---|
| `EvaluationReport` | Report renderer (future) | Markdown narrative of a single run evaluation, with tables for Foreman/worker dimension scores and links to source evidence. |
| `ScorecardReport` | Report renderer (future) | Markdown summary of a per-scope scorecard, including confidence, skipped-evidence reasons, and trend context. |
| `HistoryReport` | `src/autoresearch/sol-report.ts` (`formatReportCli`) | CLI table or Markdown table of aggregate snapshot groups. |
| `RecommendationsReport` | `src/autoresearch/sol-recommendations.ts` (`formatRecommendationsCli`) | Human-readable rationale for each advisory recommendation. |

## Report taxonomy

| Report | Subject | Key dimensions | Source evidence |
|---|---|---|---|
| **Foreman evaluation report** | Foreman orchestrator | token, duration, intervention, pre-analysis, dependency, dispatch, evidence validation, scope, completion, recovery, QC repair loop | run state, telemetry, result packets |
| **Worker evaluation report** | Individual worker child | token, duration, validation, QC, repair iterations, scope adherence, acceptance criteria, first-pass | child result packet, telemetry, QC artifacts |
| **Provider evaluation report** | Execution provider | mean/min/max composite across runs grouped by provider; fallback/exhaustion rates | telemetry `provider-selected`, `provider-fallback-attempted`, `provider-exhausted` |
| **Model evaluation report** | Provider model | composite and dimension scores grouped by model | result packets, telemetry |
| **Routing evaluation report** | Worker Router decisions | router exhaustion reasons, candidate scores, policy rule hits, recurring failure patterns | router evidence, telemetry |
| **Token efficiency report** | Token usage | bootstrap and per-child token budgets, over-budget decay, time-window trends | telemetry `bootstrap-context-size`, `worker-heartbeat` token fields |
| **QC evaluation report** | Quality control findings | findings by severity/attribution, repair loop rounds, packets compiled/completed/failed, noisy providers | `.polaris/clusters/<cluster-id>/qc/` findings, telemetry QC events |
| **Intervention report** | Corrective actions | user/foreman intervention frequency, out-of-scope events, blocked events, state repair | telemetry `worker-blocked`, `worker-heartbeat`, intervention events |
| **Recommendation report** | Review-gated proposals | advisory actions, affected dimensions, confidence, rationale, source refs | aggregate reports and historical snapshots |

## Raw metric preservation versus aggregate scorecards

**Raw metrics are immutable.** Raw evidence includes run state, telemetry JSONL, worker result packets, QC artifacts, cluster state, and router evidence. SOL never rewrites, deletes, or patches these files to make a scorecard look better.

**Scorecards are derived and reproducible.** A scorecard is computed from raw metrics with an explicit formula version and stores `source_refs` back to the raw evidence. If the raw evidence changes, the scorecard is regenerated; if a scorecard conflicts with raw evidence, the raw evidence wins.

**Aggregate scorecards are summaries, not replacements.** History reports and grouped scorecards collapse many snapshots into mean/min/max composite values. They are useful for trend detection but cannot reproduce the original raw metrics. Aggregates must link to the underlying run IDs and snapshot files so reviewers can drill down.

## Non-mutating boundary

SOL evaluation reports are strictly advisory. They may:

- Surface trends, outliers, and improvement opportunities.
- Feed `RecommendationsReport` inputs.
- Be filed as tracker issues or PR review artifacts for human approval.

They must not:

- Change provider policy, model mappings, trust thresholds, or cost thresholds.
- Modify worker router state, dispatch logic, or active run behavior.
- Rewrite historical telemetry, run state, cluster state, or QC artifacts.
- Auto-apply recommendations.

Any action that mutates runtime behavior or policy requires an explicit, review-gated downstream step outside the report layer.

## Artifact locations

### Machine-readable artifacts

| Artifact | Location | Format |
|---|---|---|
| Run evaluations | `.polaris/sol/evaluations/<run-id>.json` | JSON |
| Per-scope scorecards | `.polaris/sol/scorecards/<scope>/<key>.json` | JSON |
| History snapshots | `.polaris/sol/history/<window>.jsonl` | JSONL |
| Recommendations | `.polaris/sol/recommendations/<generated-at>.json` | JSON |

### Human-readable artifacts

| Artifact | Location | Format |
|---|---|---|
| Evaluation reports | `smartdocs/reports/sol/evaluation-<run-id>.md` | Markdown |
| Scorecard reports | `smartdocs/reports/sol/scorecard-<scope>-<key>.md` | Markdown |
| History reports | `smartdocs/reports/sol/history-<window>.md` | Markdown |
| Recommendation reports | `smartdocs/reports/sol/recommendations-<generated-at>.md` | Markdown |
| Taxonomy and architecture | `smartdocs/reports/sol/sol-evaluation-report-architecture.md` | Markdown |

## Source evidence references

Every report class must carry `source_refs` that name at least the following artifacts when available:

- `.taskchain_artifacts/polaris-run/current-state.json`
- `.taskchain_artifacts/polaris-run/runs/<run-id>/telemetry.jsonl`
- `.polaris/clusters/<cluster-id>/results/<child-id>-*.json`
- `.polaris/clusters/<cluster-id>/cluster-state.json`
- `.polaris/clusters/<cluster-id>/qc/` (QC findings)
- `.polaris/clusters/<cluster-id>/router/` or telemetry router events

Missing evidence reduces confidence and is recorded in `skipped_reason`; it does not block reporting.

## Relationship to upstream systems

- **Worker Router** (`src/loop/router/`) produces routing decisions and telemetry; SOL reports score those decisions without replacing router scheduling.
- **QC** (`src/qc/`) produces normalized findings; SOL reports treat QC as advisory input and do not invoke QC providers.
- **Loop / Parent** (`src/loop/`) emits telemetry; SOL aggregates it.
- **Autoresearch** (`src/autoresearch/`) implements scoring, history, aggregation, and recommendation generation as a SOL sub-capability.

## Current implementation notes

- `src/autoresearch/sol-scorer.ts` currently emits `SolScoreReport` to stdout via `polaris sol score-report`.
- `src/autoresearch/sol-history.ts` currently persists snapshots to `.polaris/sol-history/scores.jsonl` (transitional path); the canonical target is `.polaris/sol/history/<window>.jsonl`.
- `src/autoresearch/sol-report.ts` generates `SolReport` aggregates and CLI formatting; Markdown renderers will be added in implementation children.
- `src/autoresearch/sol-recommendations.ts` produces advisory `RecommendationsReport`; filing is gated by `assertPolarisDevContext()`.
