#!/usr/bin/env bash
# Classifier fixtures only: no destructive commands are executed.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
    printf 'SKIP: command-risk tests require Node.js 24+\n'
    exit 0
fi
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test "$ROOT/scripts/tests/pi-command-risks.test.ts"
