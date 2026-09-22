#!/usr/bin/env bash
set -euo pipefail
if command -v mise >/dev/null 2>&1; then
  exec mise x -- python "$(git rev-parse --show-toplevel)/tools/agentmap_lint.py" --pre-push --report "$@"
else
  exec python3 "$(git rev-parse --show-toplevel)/tools/agentmap_lint.py" --pre-push --report "$@"
fi
