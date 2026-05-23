# src/config

## Purpose

The config subsystem loads, validates, and provides the resolved `PolarisConfig` to all other subsystems. It reads `polaris.config.json` from the repo root, merges it with compiled defaults, and validates the result against the JSON schema.

## What belongs here

- `schema.ts` — TypeScript types for `PolarisConfig` (generated or hand-authored from `schema.json`)
- `schema.json` — JSON Schema definition for `polaris.config.json`
- `defaults.ts` — `DEFAULT_CONFIG` constant (the compiled baseline configuration)
- `loader.ts` — `loadConfig(repoRoot)` function and `PolarisConfigError` class
- `validator.ts` — JSON Schema validation logic

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

## Architecture assumptions

- `polaris.config.json` is optional at the repo root. Missing file = use all defaults.
- Deep merge means nested objects are combined key-by-key; a user config that sets `map.autoWriteAbove` does not clobber other `map.*` keys.
- Schema validation runs on the user-supplied partial config, before merging with defaults. Defaults are trusted and not re-validated.

## Read before editing

- `polaris.config.json` (repo root) — the live configuration for this repo
- `src/config/defaults.ts` — current default values
- `src/config/schema.json` — authoritative field definitions and constraints

## Related routes

- `polaris.config` — all files in this directory
