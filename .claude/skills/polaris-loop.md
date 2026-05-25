# polaris-loop

Invoke Polaris loop subcommands: `continue` or `status`.

## Subcommands

| Subcommand | CLI invocation | Purpose |
|---|---|---|
| `continue` | `polaris loop continue` | Advance the current taskchain loop one step |
| `status` | `polaris loop status` | Print the current loop state |

## Steps

1. Determine which subcommand the user wants: `continue` or `status`.
   - If ambiguous, ask the user to clarify.

2. Determine the Polaris binary to use:
   - If `$POLARIS_BIN` is set, use that value as the command prefix.
   - Otherwise, use `polaris`.

3. Run the command:
   ```
   polaris loop <subcommand>
   ```
   or, with `$POLARIS_BIN`:
   ```
   $POLARIS_BIN loop <subcommand>
   ```

4. If the command exits non-zero, report the error output and stop.

5. If the command succeeds, display the output to the user.

## Preconditions

- The Polaris CLI must be built and reachable. See `.claude/README.md` for setup.
- Run `npm run build` in the Polaris repo if `dist/cli/index.js` is missing or stale.

## Notes

- Both subcommands are stubs until Cluster 4 (POL-5) is implemented.
- Do not fabricate loop state; relay exactly what the CLI prints.
- `polaris loop status` is equivalent to `polaris status` (both supported by the CLI).
