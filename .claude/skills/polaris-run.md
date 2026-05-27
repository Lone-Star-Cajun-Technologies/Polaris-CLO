# polaris-run

> **Canonical skill**: `.codex/skills/polaris-run/SKILL.md` (+ `chain.md`)
> This file is a Claude-specific invocation wrapper. All Polaris runtime doctrine lives in the Codex skill.

Use this skill when the user asks to run a governed Polaris implementation cluster.
Before proceeding, read `.codex/skills/polaris-run/SKILL.md` and `.codex/skills/polaris-run/chain.md` — they are the authoritative instructions.

## Invocation

1. Build the CLI if `dist/cli/index.js` is missing or stale:
   ```
   npm run build
   ```

2. Run via `npm run polaris` (preferred) or the binary directly:
   ```
   npm run polaris -- run
   ```
   With `$POLARIS_BIN` override:
   ```
   $POLARIS_BIN run
   ```

3. If the command exits non-zero, report the error output and stop.

4. If the command succeeds, follow the step-by-step instructions in `chain.md`.

## Hard rules (from canonical Codex skill)

- Checkpoint-only state writes: session-start, child-complete (via `polaris loop continue`), session-end, blocker.
- Worker spawn guard: narrow single-repo children execute directly — no worker spawn by default.
- Map update: `polaris map update --changed` runs **once at session end**, never per child.
- Worker owns child completion state; orchestrator does not rewrite it.
- Linear updates only at child completion or blocker. No mid-step churn.
- Do not fabricate run output; relay exactly what the CLI prints.
