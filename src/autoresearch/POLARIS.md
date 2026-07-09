# autoresearch (SOL sub-capability)

## Purpose

The autoresearch subsystem is a dev-gated SOL sub-capability that provides retroactive run scoring and artifact improvement proposal routing. It reads completed run artifacts, evaluates a set of binary quality gates, summarizes router outcomes from dispatch telemetry, and files fix-zone-mapped proposals as tracker issues for human review.

**Domain:** autoresearch
**Route:** src/autoresearch

## Relationship to SOL

Autoresearch is the evidence-scoring and proposal-routing sub-capability inside the broader Self-Optimization Loop (SOL). SOL observes run evidence, evaluates performance, maintains historical trends, and generates review-gated recommendations. Autoresearch executes the scoring (`score.ts`), gating (`gates.ts`), proposal mapping (`proposal.ts`), and proposal routing (`routing.ts`) steps on SOL's behalf.

## What belongs here

- `score.ts` — `scoreRun()`: loads run artifacts, evaluates 8 binary gates, summarizes router outcomes (`RouterOutcomesSummary`) from telemetry events, and emits a `DiagnosisReport`; `summarizeRouterOutcomes()` aggregates `provider-selected`, `provider-fallback-attempted`, and `provider-exhausted` events into failure counts and recurring-failure patterns
- `proposal.ts` — `buildProposals()`: maps failed gates to `AutresearchProposal` fix zones
- `routing.ts` — `routeProposals()`: files proposals as Linear issues (never auto-applied)
- `gates.ts` — `ALL_GATES` registry and `GateResult` types; `readJsonLines()` helper
- `dev-gate.ts` — `isPolarisDevContext()` and `assertPolarisDevContext()`: all autoresearch commands must call `assertPolarisDevContext()` before any file-system or network access
- `sol-scorer.ts` — `computeSolScoreReport()`: computes per-run Foreman and worker dimension scores, composite scores, and confidence from aggregated `SolEvidence`
- `sol-report.ts` — `generateReport()` / `formatReportCli()`: groups historical `SolScoreSnapshot`s into aggregate `SolReport` summaries and renders QC evidence
- `sol-evaluation-writer.ts` — `writeEvaluationRecord()` / `writeScorecardSet()` / `writeSolMarkdownReport()`: persists machine-readable SOL evaluation records under `.polaris/sol/evaluations/`, scorecard snapshots under `.polaris/sol/scorecards/<subject>/`, and human-readable SmartDocs reports under `smartdocs/reports/sol/`
- `sol-report-renderer.ts` — `renderSolMarkdown()`: renders human-readable SOL evaluation reports with source references, confidence, skipped evidence, grouping windows, recommendation inputs, QC outcome, and token-efficiency summaries
- `sol-history.ts` — `appendSnapshot()` / `loadSnapshots()`: persists and reads `SolScoreSnapshot` JSONL history
- `sol-recommendations.ts` — `generateRecommendations()`: produces explainable routing/role/provider/model recommendations from historical SOL snapshots; advisory by default; `recommendationsToProposals()` converts recommendations to tracker issues for human review
- `index.ts` — public re-exports

## What does not belong here

- Direct router implementation — belongs in `src/loop/router/`
- Issue tracking API logic beyond filing proposals — belongs in `src/tracker/`
- Non-dev-gated scoring commands — all autoresearch commands are dev-only

## Editing rules

- All action handlers must call `assertPolarisDevContext()` before touching any file system or network resource.
- `scoreRun()` must read `completed_children_results` from run state when available; filter out librarian, Medic, and chart artifacts before scoring worker result packets.
- `summarizeRouterOutcomes()` reads JSONL telemetry events: `provider-selected` (includes `router_mode`, `router_task_type`), `provider-fallback-attempted`, `provider-exhausted` (includes `router_exhausted_reason`, `router_candidates`). Aggregate by `router_exhausted_reason` to detect recurring failures.
- `buildProposals()` must never auto-apply changes; proposals are filed for human review only.
- `generateRecommendations()` is advisory by default; tracker filing requires explicit opt-in and is gated by `assertPolarisDevContext()`.
- Autoresearch is a downstream SOL consumer and recommendation producer, not a replacement for the Worker Router (`src/loop/router/`) or QC (`src/qc/`).
- Scoring gates treat foreman packet resend as same-child redispatch (not multi-session epochs).

## Architecture assumptions

- `scoreRun()` is the primary entry point; `buildProposals()` and `routeProposals()` operate on its output.
- Router outcome data originates from telemetry events emitted by `src/loop/dispatch.ts` and `src/loop/parent.ts`.
- All commands are unavailable in consumer repos (dev-gate blocks them).

## Read before editing

- `src/autoresearch/dev-gate.ts` — dev-gate logic
- `src/autoresearch/gates.ts` — gate definitions and types
- `smartdocs/specs/raw/pol-478-self-optimization-loop-architecture.md` — SOL architecture and boundaries
- `smartdocs/specs/active/worker-router-architecture.md` — §3.9 SOL telemetry event catalog
- `src/loop/dispatch.ts` — telemetry emission that feeds scoring

## SOL evaluation reports

Autoresearch emits machine-readable SOL evaluation artifacts and renders them into human-readable reports. The report taxonomy, artifact boundaries, and canonical locations are defined in `smartdocs/reports/sol/sol-evaluation-report-architecture.md`.

| Layer | Responsibility | Location |
|---|---|---|
| Machine-readable evaluations | `SolScoreReport`, `SolReport`, `RecommendationsReport` | `.polaris/sol/evaluations/`, `.polaris/sol/scorecards/`, `.polaris/sol/history/`, `.polaris/sol/recommendations/` |
| Human-readable reports | Markdown renderings of evaluations, scorecards, history, and recommendations | `smartdocs/reports/sol/` |

Reports are read-only summaries. They may inform review-gated recommendations but do not mutate runtime state, provider policy, or historical evidence.

## QC relationship

- Autoresearch consumes normalized QC metrics as advisory SOL inputs; it does not invoke QC providers.
- `scoreRun()` reads QC result artifacts from `.polaris/clusters/<cluster-id>/qc/` and weights findings by severity and attribution confidence.
- QC findings are treated as noisy observations; autoresearch aggregates patterns and proposes follow-up analysis or human review, never a unilateral block.

## QC repair loop SOL evidence

The repair loop emits additional JSONL telemetry events that `scoreRun()` and `summarizeRouterOutcomes()` must read when present. New SOL evidence fields introduced by POL-501:

- `provider_attempt_count` — total provider invocations across fallback chain.
- `provider_failure_class` — failure class for each failed provider attempt.
- `repair_round_count` — number of repair rounds executed.
- `compiled_packet_count` — total repair packets compiled this run.
- `repair_worker_outcomes` — per-packet: `{packet_id, worker_id, status, finding_ids_resolved}`.
- `unresolved_finding_escalation_reason` — why a finding was not resolved (`max-rounds`, `operator-review`, `medic-referral`).
- `max_round_stop_reason` — human-readable reason the round limit was hit.
- `medic_referral_packet_ids` — packet IDs referred to Medic.

Repair loop telemetry events to aggregate (in addition to existing QC events):

| Event | SOL signal |
|---|---|
| `qc-provider-attempted` / `qc-provider-failed` | Provider reliability; fallback chain depth. |
| `qc-repair-round-started` / `qc-repair-round-complete` | Rounds consumed per cluster. |
| `qc-repair-packets-compiled` | Repair packet count and severity distribution. |
| `qc-repair-packet-complete` | Per-packet repair success/failure rate. |
| `qc-max-rounds-reached` | Escalation rate; signal for raising `maxRepairRounds`. |
| `qc-operator-review-required` | Operator escalation rate by finding category. |
| `qc-medic-referral-required` | Medic referral rate from QC repair path. |

These events are emitted by `src/qc/orchestration.ts`. Autoresearch reads them from the run telemetry JSONL file alongside existing `provider-selected` / `provider-fallback-attempted` / `provider-exhausted` events.

Full repair loop telemetry event catalog: `smartdocs/specs/active/quality-control-architecture.md §8.9`.

## Related routes

- `src/cli/autoresearch.ts` — `polaris sol` CLI command surface; `polaris autoresearch` remains a compatibility alias
- `src/loop/` — telemetry source for router outcome events
- `src/tracker/` — issue filing for proposals
