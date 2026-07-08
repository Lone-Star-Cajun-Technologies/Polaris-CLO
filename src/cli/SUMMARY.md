# Summary: cli

## Purpose
Command-surface assembly for the `polaris` binary. This folder defines top-level CLI behavior, wires subsystem commands, and enforces consistent help/error semantics.

## Core Concepts
- `index.ts` is wiring-only: it composes command factories and shared handlers.
- Subsystem command logic belongs outside `src/cli/` (loop/map/finalize/config/docs/graph/etc.).
- Bare subsystem invocations and unknown commands must fail with actionable guidance.
- Graph commands (`build`, `query`, `impact`) are surfaced from `graph.ts` and operate on graph store/query services.
- Worker and librarian command groups exist for runtime-governed execution paths.
- `welfare-check` is a safe/read-only top-level command backed by map welfare logic and exits non-zero when route review is required.
- `init --adopt` scaffolds root surfaces, installs bundled workspace assets, migrates instruction files with provenance, runs atlas/graph setup, writes an adoption report, and stages only commit-eligible outputs.
- `upgrade` refreshes `POLARIS_RULES.md` for existing Polaris-managed repositories without rerunning adoption or rewriting repo-local skills.
- SmartDocs migration now guarantees bundle-root scaffolding by creating `smartdocs/index.md` and `smartdocs/log.md` when missing, while preserving existing file content.
- `polaris adopt consolidate --dry-run` is a zero-write guarantee: `migrateSmartDocs()` and `reconcileAgentFiles()` gate every mutating call behind `plan.dry_run` and log intended actions instead.

## Architectural Role
This route is the external operator interface for Polaris. It exposes runtime capabilities without owning business logic, preserving separation between command UX and subsystem implementation.

## Key Constraints
- Keep command registration declarative and centralized in `index.ts`.
- Do not embed subsystem business logic in CLI handlers.
- Keep output modes predictable (`--json`, dry-run, human-readable summaries).
- Preserve non-zero exits for invalid command forms.

## Important Relationships
- Depends on `src/loop/`, `src/map/`, `src/finalize/`, `src/config/`, `src/smartdocs-engine/`, `src/graph/`, and `src/skill-packet/` for command factories.
- Uses `src/loop/finalize-evidence.ts` and CLI subtask bridge setup to enforce finalize/run invariants.
- Shares version source with `package.json` through `src/cli/version.ts`.

## Current State
Top-level command groups include status, loop, map, finalize, runs, init, upgrade, docs/doctrine, config, tracker, worker, graph, skill, librarian, medic, welfare-check, autoresearch, and a future `sol` surface. `polaris autoresearch` is retained as a compatibility alias; the preferred future surface is `polaris sol`, scoped to the Self-Optimization Loop (SOL). Graph command UX supports build/query/impact plans, JSON output, and build coverage reporting. Adoption now uses bundled `src/workspace/` assets, `POLARIS_RULES.md` as the global agent-governance pointer, lossless instruction migration/provenance, and a fresh-repo integration proof. `migrateSmartDocs()` now unconditionally scaffolds `smartdocs/index.md` and `smartdocs/log.md` if missing during init/adopt migration paths, without overwriting existing files. `upgrade-command.ts` refreshes `POLARIS_RULES.md` to the current CLI version via `refreshPolarisRules()` while preserving the existing Repository Overview and skipping when the embedded version stamp is current. The `medic chart create` command scaffolds new Medic diagnostic charts in `smartdocs/medic/charts/` with auto-generated CHART-YYYY-MM-DD-NNN IDs. The `welfare-check` command reports route identity and health review needs from the atlas. `agent-setup.ts` provides `resolveForeman()` (idempotent Foreman provider resolution with config persistence) and `runAgentSetup()` (interactive multi-role provider assignment). For empty/new repos, `init.ts` drives a three-step setup flow via `setup-interview/`: interview (`runner.ts`, question-by-question TTY with resume support, persisted to `.polaris/setup/interview.json`), approval-gated artifact generation (`generate.ts`, writes `GENESIS.md`, `polaris.config.json`, `POLARIS_RULES.md`, root route surfaces, SmartDocs intake, and map index), and a checkpoint report (`report.ts`, validates all generated files and writes a JSON report to `.polaris/runs/`). `adopt-approve.ts` now accepts an optional `markdown` override and custom `persist` callback, used by the setup generate step to present a setup-specific plan and persist interview approval. For existing repos, `init.ts` and `adopt-command.ts` generate a `SetupBootstrapPacket` and launch the Foreman via `dispatchForeman()` after provider setup; dispatch is best-effort and does not block the init/adopt flow. Adoption now uses a two-model design: `adoption-context.ts` stores operator answers (trusted_docs, stale_docs, never_touch, priority_systems, instruction_file_intent) in `.polaris/adoption/operator-context.json` separately from scan evidence; `adoption-plan.ts` merges both to assign per-step `evidence_refs`, `operator_refs`, and `routing` (raw | candidate | hold | review-required). `adopt-command.ts` includes an `interview` phase that seeds questions from scan gaps and persists answers before plan generation. `requireApprovalGates()` in `adopt-approve.ts` gates four mutation categories (route-scaffold, doc-movement, instruction-file, graph-root) with per-category diff preview and explicit y/N approval before any mutation runs; non-interactive runs without a supplied stdin are blocked. `adopt-assets.ts` step 6 calls `syncShims()` from `src/agent-plugin/sync.ts` to generate and version-stamp Claude Code slash-command shims under `.claude/commands/` during every workspace asset install; `WorkspaceInstallResult` exposes the result as a `shimSync` field. `autoresearch.ts` exposes `polaris autoresearch score <run-id>` (runs the binary gate scorecard from `src/autoresearch/score.ts` and outputs a `DiagnosisReport` JSON) and `polaris autoresearch propose <diagnosis-file>` (builds `AutresearchProposal` objects from a saved report and routes them to Linear via `src/autoresearch/routing.ts`); both commands call `assertPolarisDevContext()` before execution and are unavailable in consumer repos.

## Known Drift
Older references that describe only the legacy command subset are stale and should defer to `src/cli/index.ts` command registration.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/cli/index.ts`
- `src/cli/graph.ts`
- `src/cli/librarian.ts`
- `src/cli/setup-interview/runner.ts`
- `src/cli/setup-interview/generate.ts`
