#!/usr/bin/env bash
# polaris-run.sh — outer loop runner for polaris-run clusters
#
# Calls `claude -p` in a loop, each session handles one child.
# Reads .taskchain_artifacts/polaris-run/current-state.json after each
# session to decide whether to continue, stop, or halt on a blocker.
#
# Usage:
#   scripts/polaris-run.sh <issue-id> [options]
#
# Options:
#   --max-sessions N    Safety cap on total sessions (default: 30)
#   --model MODEL       Claude model to use (default: claude's default)
#   --deliver           After all children Done, run finalize delivery session
#   --dry-run           Print what would run without executing
#
# Exit codes:
#   0  All children Done (or delivery complete)
#   2  Blocked — manual intervention required
#   3  Safety session limit reached
#   1  Unexpected error

set -euo pipefail

ISSUE=${1:?Usage: scripts/polaris-run.sh <issue-id> [--max-sessions N] [--model MODEL] [--deliver] [--dry-run]}
shift

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
STATE_FILE="$REPO_ROOT/.taskchain_artifacts/polaris-run/current-state.json"
MAX_SESSIONS=30
MODEL_FLAG=""
DELIVER=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-sessions) MAX_SESSIONS="$2"; shift 2 ;;
    --model)        MODEL_FLAG="--model $2"; shift 2 ;;
    --deliver)      DELIVER=true; shift ;;
    --dry-run)      DRY_RUN=true; shift ;;
    *) echo "[polaris-run] Unknown flag: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[polaris-run] $*"; }
err() { echo "[polaris-run] ERROR: $*" >&2; }

read_state_field() {
  local field="$1"
  local default="${2:-}"
  if [[ ! -f "$STATE_FILE" ]]; then echo "$default"; return; fi
  node --input-type=module <<EOF 2>/dev/null || echo "$default"
import { readFileSync } from 'fs';
const s = JSON.parse(readFileSync('$STATE_FILE', 'utf8'));
const v = s.$field;
process.stdout.write(Array.isArray(v) ? String(v.length) : String(v ?? '$default'));
EOF
}

run_session() {
  local prompt="$1"
  # shellcheck disable=SC2086
  local cmd="claude -p $(echo $MODEL_FLAG) \"$prompt\""
  if $DRY_RUN; then
    log "[dry-run] would run: $cmd"
    return 0
  fi
  # shellcheck disable=SC2086
  claude -p $MODEL_FLAG "$prompt"
}

sessions=0

log "Starting loop for $ISSUE (max $MAX_SESSIONS sessions)"
log "State file: $STATE_FILE"

while [[ $sessions -lt $MAX_SESSIONS ]]; do
  sessions=$((sessions + 1))
  log "--- Session $sessions ---"

  if ! run_session "polaris-run on $ISSUE"; then
    err "claude exited non-zero on session $sessions — stopping"
    exit 1
  fi

  status=$(read_state_field status unknown)
  open_count=$(read_state_field open_children 0)

  log "Session $sessions ended — status=$status open_children=$open_count"

  case "$status" in
    stopped)
      if [[ "$open_count" -eq 0 ]]; then
        log "All children Done — cluster complete"
        if $DELIVER; then
          log "--- Delivery session ---"
          run_session "polaris-run on $ISSUE. Finalize delivery."
          log "Delivery complete"
        else
          log "To deliver: scripts/polaris-run.sh $ISSUE --deliver"
          log "Or: claude -p \"polaris-run on $ISSUE. Finalize delivery.\""
        fi
        exit 0
      fi
      log "Child complete — starting next session"
      ;;
    all-children-complete)
      log "All children Done — cluster complete"
      if $DELIVER; then
        log "--- Delivery session ---"
        run_session "polaris-run on $ISSUE. Finalize delivery."
        log "Delivery complete"
      else
        log "To deliver: scripts/polaris-run.sh $ISSUE --deliver"
      fi
      exit 0
      ;;
    complete)
      log "Run complete — PR delivered"
      exit 0
      ;;
    blocked)
      err "Blocked — manual intervention required"
      err "Resolve the blocker, then re-run: scripts/polaris-run.sh $ISSUE"
      exit 2
      ;;
    *)
      err "Unexpected status '$status' after session $sessions — stopping"
      err "Check $STATE_FILE for details"
      exit 1
      ;;
  esac
done

err "Safety limit reached ($MAX_SESSIONS sessions) — stopping"
err "Re-run to continue: scripts/polaris-run.sh $ISSUE"
exit 3
