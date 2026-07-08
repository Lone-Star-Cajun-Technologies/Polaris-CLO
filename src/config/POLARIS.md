# src/config

## Purpose

The config subsystem loads, validates, and provides the resolved `PolarisConfig` to all other subsystems. It reads `polaris.config.json` from the repo root, merges it with compiled defaults, and validates the result against the JSON schema.

## What belongs here

- `loader.ts` — `loadConfig(repoRoot)`: loads, merges, and validates config
- `defaults.ts` — `DEFAULT_CONFIG` baseline (must always pass schema validation)
- `schema.ts`, `schema.json` — TypeScript types and JSON Schema definition
- `validator.ts` — schema validation logic
- `graph` config fields — graph output path and invalidation triggers for graph governance
- Provider detection helpers — compaction providers remain separate from repo-analysis providers; repo analysis prefers Polaris graph only.
- `sol` config fields — `SolConfig` with `history.enabled` (default `false`) and `history.path` (default `.polaris/sol-history`) for SOL history persistence; snapshots are not written unless `history.enabled` is `true`.

## What does not belong here

- Command registration — `polaris config show` lives in `src/cli/index.ts`
- State file reading — belongs in `src/loop/checkpoint.ts`
- Any runtime state or session data

## Editing rules

- `DEFAULT_CONFIG` in `defaults.ts` must always be a valid `PolarisConfig` that passes schema validation. Never set a default that the validator would reject.
- `loadConfig` performs a deep merge of `DEFAULT_CONFIG` with `userConfig`. Scalar values from `userConfig` override defaults; object values are merged recursively. Arrays are replaced, not concatenated.
- `PolarisConfigError` must carry the full `errors` array from validation — callers display these to the user.
- When adding a new config field: (1) update `schema.json`, (2) update `schema.ts`, (3) add a default to `DEFAULT_CONFIG`, (4) update `validator.ts` if needed.
- All subsystems call `loadConfig(repoRoot)` — never read `polaris.config.json` directly with `fs` outside this module.
- Graph governance uses `config.graph.outputPath` (default `.polaris/graph`) and `config.graph.invalidationTriggers` (`repo-change`, `config-change`) to manage graph rebuild state.
- Repo-analysis detection must not prefer external providers over Polaris graph for Polaris-managed repos.

## Route model

- `polaris.config.json` is optional at the repo root. Missing file = use all defaults.
- Deep merge means nested objects are combined key-by-key; a user config that sets `map.autoWriteAbove` does not clobber other `map.*` keys.
- Schema validation runs on the user-supplied partial config, before merging with defaults. Defaults are trusted and not re-validated.
- Graph settings are optional; if omitted, graph governance writes to `.polaris/graph` and watches both repo and config changes.
- `detectRepoAnalysisProviders()` returns `polaris-graph` when the `polaris` command is available; GitNexus detection is limited to compaction-provider compatibility.

## Read before editing

- `polaris.config.json` (repo root) — the live configuration for this repo
- `src/config/defaults.ts` — current default values
- `src/config/schema.json` — authoritative field definitions and constraints
- `src/graph/governance.ts` — consumer of `config.graph` behavior
- `smartdocs/specs/active/worker-router-architecture.md` — future Worker Router config types and invariants (default remains single-worker)

## Architecture notes

- The `execution.routerPolicy` config surface (`WorkerRouterPolicyConfig`) is the live provider eligibility and slot-pool configuration for the Worker Router. It is present in `schema.ts`, `schema.json`, and `defaults.ts`. Key sub-fields: `defaultWorkerPool.maxActiveWorkers` (default `1`), `providerRegistry` (per-provider eligibility, role, capability, quota, trust, cost, and max slot declarations), `allowCrossAgentFallback` (default `false`).
- With `routerPolicy` absent or all defaults, behavior is identical to the pre-router single-worker loop: one active worker, first configured provider selected, no cross-agent fallback.
- The `sol` config surface (`SolConfig`) controls SOL history persistence. `sol.history.enabled` (default `false`) gates all snapshot writes; `sol.history.path` (default `.polaris/sol-history`) sets the storage directory relative to the repo root. Consumers must check `history.enabled` before writing snapshots.

## Related routes

- `polaris.config` — all files in this directory
