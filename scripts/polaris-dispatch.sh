#!/usr/bin/env bash
set -euo pipefail
polaris loop continue --provider "${1:-claude}"
