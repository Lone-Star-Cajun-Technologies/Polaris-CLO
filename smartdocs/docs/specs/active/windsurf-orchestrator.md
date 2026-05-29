# Windsurf as Polaris Orchestrator

## Role

Windsurf acts as an **orchestrator/delegator** in Polaris cluster execution. It does not spawn native subagents — it delegates work by invoking terminal commands. Windsurf triggers one dispatch per step, reads state from git, and decides whether to continue.

## Setup

Ensure `polaris` is available on the PATH before running the dispatch script:

```bash
npm link polaris       # from the repo root, or
npx polaris            # if not globally linked
```

Verify with:

```bash
polaris --version
```

## Usage

From the repo root, run the dispatch script via Windsurf's command runner:

```bash
./scripts/polaris-dispatch.sh [<provider>]
```

The script executes:

```bash
polaris loop continue --provider <provider>   # when provider is specified
polaris loop continue                          # when omitted — uses rotation[0] from config
```

**Provider options (must be configured in `polaris.config.json` `execution.providers`):**

| Provider   | CLI binary  | Description                                      |
|------------|-------------|--------------------------------------------------|
| `claude`   | `claude`    | Claude Code CLI (Anthropic)                      |
| `codex`    | `codex`     | OpenAI Codex CLI                                 |
| `gemini`   | `gemini`    | Google Gemini CLI                                |
| `copilot`  | `copilot`   | GitHub Copilot CLI (`-p <prompt> --autopilot --allow-all-tools`) |
| `custom`   | `$POLARIS_AGENT` | Any agent set via environment variable      |

Windsurf does not pick the provider automatically. Provider selection is explicit and config-controlled.

## Idempotency

If the loop is already at `STOP` or `CLUSTER COMPLETE` state, `polaris loop continue` exits cleanly with code 0. Re-running the dispatch script is safe.

## Cross-Provider Delegation

Provider routing is declared in Polaris configuration, not in Windsurf. To change which provider executes a child task, update the provider mapping in the run config — not the command invocation.
