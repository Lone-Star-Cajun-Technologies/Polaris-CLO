# polaris-loop

> **Canonical skill**: `.polaris/skills/polaris-run/SKILL.md` (+ `chain.md`)
> This file is a Claude-specific invocation wrapper. All Polaris loop doctrine lives in the canonical skill.

Invoke Polaris loop subcommands: `continue` or `status`.

## Subcommands

| Subcommand | CLI invocation | Purpose |
|---|---|---|
| `continue` | `polaris loop continue` | Checkpoint the completed child, emit JSONL event, generate next bootstrap packet |
| `status` | `polaris loop status` | Print compact current run state |

## Steps

1. Build the CLI if `dist/cli/index.js` is missing or stale:
   ```
   npm run build
   ```

2. Determine which subcommand the user wants: `continue` or `status`.
   - If ambiguous, ask the user to clarify.

3. Run via `npm run polaris` (preferred) or binary directly:
   ```
   npm run polaris -- loop <subcommand>
   ```
   With `$POLARIS_BIN` override:
   ```
   $POLARIS_BIN loop <subcommand>
   ```

4. If the command exits non-zero, report the error output and stop.

5. If the command succeeds, display the output to the user.

## When to call `polaris loop continue`

Only after a child commit has been made. `polaris loop continue` is the child-completion checkpoint — it writes state, emits `loop-checkpoint` telemetry, and generates the next bootstrap packet. Do not call it without a preceding commit.

## Notes

- `polaris loop status` is equivalent to `polaris status` (both supported by the CLI).
- Do not fabricate loop state; relay exactly what the CLI prints.
- For full runtime workflow doctrine, read `.polaris/skills/polaris-run/chain.md`.
