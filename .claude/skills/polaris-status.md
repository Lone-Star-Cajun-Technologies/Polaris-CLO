# polaris-status

Print the current Polaris runtime status for the active taskchain run.

## Steps

1. Determine the Polaris binary to use:
   - If `$POLARIS_BIN` is set, use that value as the command prefix.
   - Otherwise, use `polaris`.

2. Run the command:
   ```
   polaris status
   ```
   or, if `$POLARIS_BIN` is set:
   ```
   $POLARIS_BIN status
   ```

3. If the command exits non-zero, report the full error output and stop.
   Common causes:
   - `dist/cli/index.js` is missing: run `npm run build` in the Polaris repo.
   - `polaris` binary not found: run `npm link` from the Polaris repo root.
   - No `current-state.json` found: no active run in this repo.

4. If the command succeeds, display the output to the user.

## JSON mode

To get machine-readable output:
```
polaris status --json
```

## Targeting a specific state file

```
polaris status --state-file .taskchain_artifacts/polaris-run/current-state.json
```

## Preconditions

- The Polaris CLI must be built: `npm run build` in the Polaris repo.
- The binary must be reachable. See `.claude/README.md` for setup options.
- At least one Polaris run must have been started (state file must exist).

## Notes

- This command is read-only. Safe to run at any time.
- It reports the durable state from `current-state.json` — not live execution state.
- Use `polaris loop status` for an equivalent command via the loop skill.
