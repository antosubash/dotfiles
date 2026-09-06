#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
    printf 'SKIP: subagent capture tests require Node.js 24+\n'
    exit 0
fi
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "$ROOT/scripts/tests/pi-subagent-capture.test.ts"
