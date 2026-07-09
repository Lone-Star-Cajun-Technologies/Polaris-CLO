# Summary: src

## Purpose
Application source root for Polaris. The tree contains command entrypoints, loop/runtime orchestration, config loading and validation, cognition/map/Smart Docs governance, graph governance, run-health and Medic coordination, finalization, tracker adapters, and shared utilities.

## Core Concepts
- Folder-local guidance lives beside implementation in `POLARIS.md`.
- Cognition and map are read-only analysis layers; they report signals, not writes.
- Run-health reports are the canonical symptom record for a run. Workers, Foreman, and SOL append symptoms; Medic records the diagnosis decision; finalize reads the report instead of inferring health from telemetry.
- Smart Docs governs canonical documentation under `smartdocs/`, including seeded route cognition, SmartDocs indexes, frontmatter governance metadata, lifecycle logs, and canon/link checks.
- Graph route manages extraction/resolution/query/store behavior and governance outputs under `.polaris/graph/`.
- Route welfare checks combine atlas identity completeness with route health signals and are exposed through the CLI as read-only reporting.
- Autoresearch scoring is evidence-first: worker intervention gates read `completed_children_results` from run state, result packet scoring ignores non-worker artifacts, and foreman packet resend detection is based on repeated dispatches for the same child rather than multi-session dispatch epochs.
- Config changes must flow through `src/config/` and the JSON schema/validator.

## Architectural Role
`src/` is the implementation boundary for the product. The subfolders are intentionally split by concern so workers can edit one subsystem without reinterpreting the rest of the runtime.

## Key Constraints
- Avoid cross-route coupling; keep shared contracts in types or dedicated adapters.
- Do not write runtime outputs into source folders.
- Graph artifacts under `.polaris/graph/` are generated data and excluded from atlas validation and Smart Docs ingest.
- Route docs should describe current behavior, not history.

## Important Relationships
- `src/loop/` coordinates child execution, ingests run-health symptoms, and invokes cognition/map validation after children complete.
- `src/config/` defines the config surface consumed by all other routes.
- `src/run-health/` owns the symptom report schema, persistence helpers, and Medic decision state used by loop and finalize.
- `src/medic/` creates run-health charts, treatment packets, and consult results from run-health reports.
- `src/cognition/` and `src/map/` provide read-only detection signals for documentation and atlas maintenance.
- `src/smartdocs-engine/` ingests/promotes docs, seeds SmartDocs cognition/index files, validates links, records lifecycle logs, and maintains canonical authority structure.
- `src/graph/` builds graph artifacts, resolves edges, and serves query helpers for CLI consumers.

## Current State
The tree includes graph extraction/resolution/query/store modules plus adapter selection, capability reporting, governance controls, and config support for `graph.outputPath` and `graph.invalidationTriggers`. The default graph adapter registry covers TypeScript/JavaScript, C, C++, C#, Dart, Go, Java, Kotlin, Python, Rust, Shell, Svelte, and Swift, and graph builds degrade at file level for unsupported files while surfacing coverage reporting. Cognition and atlas validation treat `.polaris/graph/` as generated runtime output. Route welfare reporting now connects atlas identity completeness, route health state, and safe/read-only CLI reporting. The `medic/` route provides chart ID generation, chart schema validation, run-health consult orchestration, and treatment-packet dispatch for the Medic diagnostic role. The new run-health subsystem records symptoms in `.polaris/runs/<run-id>/run-health-report.json`, supports SOL/worker/Foreman symptom append flows, and feeds the run-health Medic gate in finalize. The `lint/` route enforces the Navigation Before Retrieval doctrine by scanning skill chain files for broad context preload patterns. The `agent-plugin/` route provides a host-agnostic slash-command manifest (`SLASH_COMMANDS`), a Claude Code shim generator that writes `.claude/commands/polaris-<verb>.md` files stamped with a version token, argument validation with arity/type checks and help-flag short-circuit, help/error message generation from the manifest, and a shim drift detector (`detectShimDrift`) and sync entry point (`syncShims`) that integrate with the adopt-assets install flow. The `autoresearch/` route provides a dev-gated retroactive run scoring pipeline: `scoreRun` reads completed run artifacts and evaluates 8 binary gates (user-intervened, foreman-resent-packet, foreman-fixed-worker-output, worker-output-required-fixing, validation-failed, worker-went-out-of-scope, foreman-token-burn-over-budget, state-repair-required), prefers `completed_children_results` from run state for WorkerResultContract evidence, filters librarian/Medic/chart artifacts out of worker result packets, treats foreman resend as a same-child redispatch signal, computes a `passed/evaluable` score, and emits a `DiagnosisReport`; `buildProposals` maps failed gates to Polaris artifact fix zones as `AutresearchProposal` objects; `routeProposals` files those proposals as Linear issues for human review (never auto-applied); all commands are gated to the Polaris development context via `isPolarisDevContext()`. The SOL self-optimization pipeline (POL-477) extended `autoresearch/` with: `sol-evidence-loader.ts` (`aggregateSolEvidence`) normalizes durable run artifacts into a `SolEvidence` record; `sol-scorer.ts` (`computeForemanScore`, `computeWorkerScore`, `computeSolScoreReport`) computes 0.0–1.0 dimensional scores with confidence tiers; `sol-history.ts` (`appendSnapshot`, `loadSnapshots`, `buildSnapshot`) persists `SolScoreSnapshot` records as append-only JSONL under `.polaris/sol-history/scores.jsonl` (gated by `sol.history.enabled` config); `sol-report.ts` (`generateReport`, `formatReportCli`) groups snapshots by configurable dimensions and produces summary reports; `sol-recommendations.ts` (`generateRecommendations`, `recommendationsToProposals`) generates explainable routing/role/provider/model recommendations from historical snapshots — advisory by default, tracker filing is opt-in and dev-gated. Shared SOL types live in `src/types/sol-evidence.ts` and `src/types/sol-score.ts`.

## Known Drift
Draft markers remain in some top-level folder docs when a subroute has not yet been fully reconciled.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/config/POLARIS.md`
- `src/cognition/POLARIS.md`
- `src/map/POLARIS.md`
- `src/graph/POLARIS.md`
- `src/smartdocs-engine/POLARIS.md`
