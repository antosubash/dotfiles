#!/usr/bin/env bash
# Static contract checks for safety-critical Pi workflow invariants.
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PASS=0
FAIL=0

require_text() {
    local file="$1" needle="$2"
    if grep -Fq "$needle" "$ROOT/$file"; then
        PASS=$((PASS + 1))
    else
        printf 'FAIL: %s is missing: %s\n' "$file" "$needle" >&2
        FAIL=$((FAIL + 1))
    fi
}

require_text pi/agent/extensions/subagent/index.ts 'if (code !== 0) fallback();'
require_text pi/agent/extensions/subagent/index.ts 'const TERMINATION_SETTLEMENT_DEADLINE_MS = 10000;'
require_text pi/agent/extensions/subagent/index.ts 'proc.stdout?.destroy();'
require_text pi/agent/extensions/subagent/index.ts 'proc.stderr?.destroy();'
require_text pi/agent/extensions/subagent/index.ts 'without charging its serialized form a'
require_text scripts/setup-pi.sh 'if ! mkdir "$SETUP_LOCK"'
require_text pi/agent/prompts/ship.md 'if ! mkdir "$SHIP_DIR"'
require_text pi/agent/prompts/ship.md 'max review passes 3'
require_text pi/agent/prompts/ship.md 'Only P0/P1 findings block shipping.'
require_text pi/agent/prompts/ship.md 'review-ledger.json'
require_text pi/agent/prompts/ship.md 'Deterministic pre-review gate'
require_text pi/agent/prompts/ship.md 'Dispatch `reviewer-fast` against `FIX_BASE...HEAD`'
require_text pi/agent/prompts/ship.md 'skipped-non-web'
require_text pi/agent/agents/reviewer-fast.md 'model: openai-codex/gpt-5.4-mini'
require_text pi/agent/agents/reviewer-fast.md 'Do not re-audit unchanged branch history.'
require_text pi/agent/prompts/vf.md 'if ! mkdir "$VF_DIR"'
require_text pi/agent/prompts/vf.md '`--qa-passed` requires an explicit `--qa-run-id`'
require_text pi/agent/prompts/vf.md 'refuse immediately when it is occupied'
require_text pi/agent/prompts/pr.md 'PR_LOCK="$GIT_DIR/pi-pr.lock"'
require_text pi/agent/prompts/pr.md 'already-exists response'
require_text pi/agent/prompts/pr.md 'After a successful create or already-exists resolution'

printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
