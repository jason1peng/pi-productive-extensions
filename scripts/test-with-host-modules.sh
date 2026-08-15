#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODULE_ROOT=${PI_HOST_MODULE_ROOT:-"$ROOT/node_modules"}
SUBAGENTS_SOURCE="$MODULE_ROOT/pi-subagents"
TYPEBOX_SOURCE="$ROOT/node_modules/@earendil-works/pi-ai/node_modules/typebox"
if [[ ! -d "$SUBAGENTS_SOURCE/src" ]]; then
  echo "required repository pi-subagents test dependency is unavailable: $SUBAGENTS_SOURCE" >&2
  exit 1
fi
if [[ ! -f "$TYPEBOX_SOURCE/package.json" ]] || [[ $(node -p "require('$TYPEBOX_SOURCE/package.json').version") != "1.1.38" ]]; then
  echo "lockfile-installed typebox@1.1.38 is unavailable: $TYPEBOX_SOURCE" >&2
  exit 1
fi
MODULES=$(mktemp -d "${TMPDIR:-/tmp}/ppe-host-modules.XXXXXX")
trap 'rm -rf "$MODULES"' EXIT HUP INT TERM
# Copy rather than symlink: Bun resolves a symlink to the source realpath before
# looking for package-local peers. The disposable copy supplies only the exact
# lockfile peer and never mutates the installed test dependency.
cp -R "$SUBAGENTS_SOURCE" "$MODULES/pi-subagents"
mkdir -p "$MODULES/pi-subagents/node_modules"
cp -R "$TYPEBOX_SOURCE" "$MODULES/pi-subagents/node_modules/typebox"
export NODE_PATH="$MODULES:$MODULE_ROOT${NODE_PATH:+:$NODE_PATH}"
export PPE_HOST_DISCOVERY_REQUIRED=1
bun "$ROOT/extensions/delivery-state-machine/tests/delivery-state-machine.test.ts"
bun "$ROOT/extensions/delivery-state-machine/benchmarks/agent-quality/tests/framework.test.ts"
bun "$ROOT/extensions/delivery-state-machine/benchmarks/model-quality/tests/infrastructure.test.ts"
bun "$ROOT/extensions/session-usage/tests/session-usage.test.ts"
bun "$ROOT/extensions/git-cleanup/tests/git-cleanup.test.ts"
