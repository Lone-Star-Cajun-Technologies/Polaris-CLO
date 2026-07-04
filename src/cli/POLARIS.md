# src/cli

## Purpose

The CLI entry point for Polaris. It wires the `polaris` binary, registers all top-level commands via Commander.js, and delegates behavior to subsystem command factories.

## What belongs here

- `index.ts` — binary entry point; registers subsystem commands via `addCommand()`
- `graph.ts` — `polaris graph build|query|impact` command group and output formatting
- `adopt-*.ts` — adoption scanning, workspace asset installation, instruction migration, report generation, `POLARIS_RULES.md` generation/refresh helpers, safe staging helpers for `polaris init --adopt`, and SmartDocs bundle-root scaffolding (`smartdocs/index.md`, `smartdocs/log.md`) via `migrateSmartDocs()`
- `upgrade-command.ts` — `polaris upgrade`; refreshes `POLARIS_RULES.md` to the current CLI version while preserving the repository overview
- `adoption-context.ts` — operator-answer model; loads/saves `.polaris/adoption/operator-context.json` (trusted_docs, stale_docs, never_touch, priority_systems, instruction_file_intent), kept separate from scan evidence
- `agent-setup.ts` — `runAgentSetup()` (interactive role/provider configuration) and `resolveForeman()` (resolves or prompts for the Foreman provider, persists to config); used by `init.ts` and `adopt-command.ts` to wire Foreman bootstrap dispatch
- `setup-interview/` — interactive setup interview for empty/new repositories: `schema.ts` (record types and `InterviewRecord` schema), `store.ts` (resumable persistent storage at `.polaris/setup/interview.json`), `runner.ts` (question-by-question TTY runner with resume support), `generate.ts` (approval-gated artifact generation from interview output — writes `GENESIS.md`, `polaris.config.json`, `POLARIS_RULES.md`, root route surfaces, SmartDocs intake, and map index), `report.ts` (post-setup validation and checkpoint report written to `.polaris/runs/`)
- `adopt-assets.ts` — workspace asset installation; step 6 of `installWorkspaceAssets()` calls `syncShims()` from `src/agent-plugin/sync.ts` to generate/update Claude Code slash-command shims under `.claude/commands/` as part of every adopt/init run
- `autoresearch.ts` — `polaris autoresearch score <run-id>` (retroactive binary gate scoring) and `polaris autoresearch propose <diagnosis-file>` (fix-zone-mapped Linear issue filing); dev-gated via `assertPolarisDevContext()`
- `librarian.ts` — closeout librarian packet/result command surface
- `medic.ts` — `polaris medic chart create` command; scaffolds Medic diagnostic charts
- `worker.ts` — worker-owned commit enforcement command factory
- `version.ts`, `version.test.ts` — version helper and test

## What does not belong in `index.ts`

- Command implementation logic — belongs in the respective subsystem (`src/map/`, `src/loop/`, `src/finalize/`, `src/smartdocs-engine/`, `src/config/`)
- Inline `.action()` handlers beyond trivial cases (e.g., `config show`)

## Editing rules

- To add a new top-level command, create a `create<Name>Command()` factory in the appropriate subsystem and register it with `program.addCommand()` here.
- Do not add inline `.action()` handlers in `index.ts` for anything beyond trivial cases (e.g., `config show`).
- Public help must label safe/read-only commands separately from mutating commands. Deferred 1.0 commands must be marked unavailable instead of sounding implemented.
- Unknown commands and bare subsystem commands must exit non-zero with actionable help.
- `welfare-check` is a safe/read-only top-level command wired from `src/map/welfare.ts`; it exits non-zero when route health review is required.
- Adoption must install bundled workspace assets, preserve instruction-file provenance, point agent files at `POLARIS_RULES.md`, and filter runtime scratch before staging.
- `polaris upgrade` is the maintenance path for existing Polaris-managed repos; it refreshes `POLARIS_RULES.md` only, uses the version stamp for idempotency, and must not rewrite repo-local skills or rerun full adoption.
- Adoption phases run in order: scan → interview → agents → (approval gates) → consolidate → map → skills → rules → canon. The interview phase writes operator answers to `adoption-context.ts` separately from scan evidence; plan generation in `adoption-plan.ts` merges both. `requireApprovalGates()` in `adopt-approve.ts` must run before any mutation phase (doc-movement, instruction-file, graph-root, route-scaffold); each gate previews the category diff and requires explicit `y` approval.
- `migrateSmartDocs()` must call bundle-root scaffolding unconditionally so `smartdocs/index.md` and `smartdocs/log.md` exist after init/adopt flows; scaffolding may create missing files but must never overwrite existing ones.
- `resolveForeman()` is the canonical Foreman provider resolution path: if `execution.providerPolicy.foreman.providers[0]` is already set, it returns immediately; otherwise it prompts once and persists the choice. Use this (not ad-hoc config reads) whenever Foreman assignment is needed.
- Autoresearch commands are dev-gated via `assertPolarisDevContext()` from `src/autoresearch/dev-gate.ts`; call it at the start of every autoresearch action handler before touching any file system or network resource.
- Foreman bootstrap dispatch from `init.ts` and `adopt-command.ts` is best-effort: dispatch errors must not block the init/adopt flow.
- Keep `index.ts` short — it should remain a thin wiring file.
- Version string comes from `getVersion()` only — do not hardcode version strings elsewhere.
- For empty/new repos, `init.ts` drives a three-step setup flow: interview (`runInterview` from `setup-interview/runner.ts`, resume-safe), approval-gated artifact generation (`generateSetupArtifacts` from `setup-interview/generate.ts`), and checkpoint report (`buildCheckpointReport` / `writeCheckpointReport` / `printCheckpointReport` from `setup-interview/report.ts`). All three steps are required and must not be skipped. All are injectable via `InitOptions` for testability.
- `upgrade-command.ts` injects `refreshPolarisRules()` and `getVersion()` for testability; keep disk refresh behavior in `adopt-rules.ts` rather than duplicating it in the command action.

## Route model

- The binary name is `polaris` (set via `program.name("polaris")`).
- `polaris upgrade` is a top-level maintenance command for refreshing `POLARIS_RULES.md`.
- Commander.js is the only CLI framework used. Do not introduce alternatives (yargs, meow, etc.).
- All subsystem commands are registered via `addCommand()` — no positional-argument-only dispatch.

## Read before editing

- `package.json` — `"bin"` field and `"version"` field that `getVersion()` reads
- `src/map/index.ts`, `src/loop/index.ts`, `src/finalize/index.ts` — command factory pattern examples
- `src/graph/` — graph pipeline/query/store behavior invoked by `graph.ts`

## Related routes

- `polaris.cli` — all files in this directory
