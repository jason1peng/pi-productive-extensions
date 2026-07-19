#!/usr/bin/env bash
set -euo pipefail
output=$(node cli.mjs '{"displayName":"Ada Lovelace"}' 2>&1) && exit 0
grep -q "toUpperCase" <<<"$output"
exit 1
