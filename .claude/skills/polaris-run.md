# polaris-run

Start or resume a Polaris run for the current taskchain.

## Steps

1. Determine the Polaris binary to use:
   - If `$POLARIS_BIN` is set, use that value as the command prefix.
   - Otherwise, use `polaris`.

2. Run the command:
   ```
   polaris run
   ```
   or, if `$POLARIS_BIN` is set:
   ```
   $POLARIS_BIN run
   ```

3. If the command exits non-zero, report the error output and stop.

4. If the command succeeds, display the output to the user.

## Preconditions

- The Polaris CLI must be built and reachable. See `.claude/README.md` for setup.
- Run `npm run build` in the Polaris repo if `dist/cli/index.js` is missing or stale.

## Notes

- `polaris run` is a stub until Cluster 4 (POL-5) is implemented.
- Do not fabricate run output; relay exactly what the CLI prints.
