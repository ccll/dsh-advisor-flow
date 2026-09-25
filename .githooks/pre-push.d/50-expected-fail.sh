#!/usr/bin/env bash
set -euo pipefail
exec python3 "$(git rev-parse --show-toplevel)/tools/expected_fail_check.py"
