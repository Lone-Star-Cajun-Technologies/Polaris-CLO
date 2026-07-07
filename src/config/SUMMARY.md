# Summary: config

## Purpose
Config loading and validation root. This folder merges `polaris.config.json` with defaults and validates the result before other subsystems consume `PolarisConfig`.

## Core Concepts
- Defaults are the trusted baseline and must remain schema-valid.
- Validation is strict for user-supplied partial config.
- Deep merge semantics apply for nested objects; arrays replace.
- New config fields must be reflected in schema, types, defaults, and validator together.
- Repo-analysis provider detection is Polaris-native: graph/map are preferred and external providers are not selected as the default analysis path.

## Architectural Role
This folder owns the config contract consumed by the rest of the runtime.

## Key Constraints
- Do not bypass `loadConfig(repoRoot)`.
- `DEFAULT_CONFIG` must remain valid on its own.
- Validation errors are returned as the full error array so callers can surface them directly.

## Important Relationships
- Consumed by loop, map, cognition, smartdocs-engine, graph governance, finalize, and tracker code.

## Current State
Config now includes a `graph` section with `outputPath` and `invalidationTriggers` for graph governance. Defaults point to `.polaris/graph` with repo/config invalidation enabled. Provider detection separates compaction providers from repo-analysis providers; repo analysis reports `polaris-graph` when the Polaris command is available. The `execution.routerPolicy` surface (`WorkerRouterPolicyConfig`) is now part of the schema and defaults: it declares `defaultWorkerPool.maxActiveWorkers` (default `1`), `providerRegistry` (per-provider eligibility, role, capability, quota, trust, cost, and slot declarations), and `allowCrossAgentFallback` (default `false`). With all defaults, router behavior is indistinguishable from the pre-router single-worker model.

## Linked Canonical Sources
- [POLARIS.md](POLARIS.md)
- `src/config/schema.ts`
- `src/config/validator.ts`
- `src/config/defaults.ts`
- `src/config/loader.ts`
