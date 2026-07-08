# autoresearch

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

## QC relationship

- Autoresearch consumes normalized QC metrics as advisory SOL inputs; it does not invoke QC providers.
- `scoreRun()` reads QC result artifacts from `.polaris/clusters/<cluster-id>/qc/` and weights findings by severity and attribution confidence.
- QC findings are treated as noisy observations; autoresearch aggregates patterns and proposes follow-up analysis or human review, never a unilateral block.

## Related routes

- `src/cli/autoresearch.ts` — CLI command surface
- `src/loop/` — telemetry source for router outcome events
- `src/tracker/` — issue filing for proposals
