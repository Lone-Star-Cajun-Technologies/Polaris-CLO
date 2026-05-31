#!/usr/bin/env bash
# polaris-dispatch.sh — invoke polaris loop continue for one dispatch step.
#
# Usage:
#   scripts/polaris-dispatch.sh [<provider>]
#
# Provider is optional. When omitted, polaris uses the first entry in
# execution.rotation from polaris.config.json.
#
# Supported providers (must be configured in polaris.config.json execution.providers):
#   claude   — Claude Code CLI (github.com/anthropics/claude-code)
#   codex    — OpenAI Codex CLI (github.com/openai/codex)
#   gemini   — Google Gemini CLI (github.com/google-gemini/gemini-cli)
#   copilot  — GitHub Copilot CLI binary `copilot` (github.com/github/copilot-cli)
#   custom   — Any agent set via $POLARIS_AGENT
#
# Examples:
#   scripts/polaris-dispatch.sh              # uses rotation[0] from config
#   scripts/polaris-dispatch.sh claude
#   scripts/polaris-dispatch.sh codex
#   scripts/polaris-dispatch.sh gemini
#   scripts/polaris-dispatch.sh copilot
set -euo pipefail

if [[ $# -gt 0 ]]; then
  polaris loop continue --provider "$1"
else
  polaris loop continue
fi
