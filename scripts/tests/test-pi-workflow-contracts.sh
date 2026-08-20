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
require_text pi/agent/extensions/subagent/index.ts 'export const MAX_CHAIN_STEPS = 8;'
require_text pi/agent/extensions/subagent/index.ts 'args.push("--exclude-tools", "subagent");'
require_text pi/agent/extensions/subagent/index.ts 'Keep child extensions (including safety guards)'
require_text pi/agent/extensions/subagent/index.ts 'Too many chain steps ('
require_text pi/agent/extensions/subagent/index.ts 'proc.stdout?.destroy();'
require_text pi/agent/extensions/subagent/index.ts 'proc.stderr?.destroy();'
require_text pi/agent/extensions/subagent/index.ts 'without charging its serialized form a'
require_text scripts/setup-pi.sh 'if ! mkdir "$SETUP_LOCK"'
require_text pi/agent/prompts/ship.md 'if ! mkdir "$SHIP_DIR"'
require_text pi/agent/prompts/ship.md 'max review passes 3'
require_text pi/agent/prompts/ship.md 'Only P0/P1 findings block shipping.'
require_text pi/agent/prompts/ship.md 'review-ledger.json'
require_text pi/agent/prompts/ship.md 'Deterministic pre-review gate'
require_text pi/agent/prompts/ship.md 'Dispatch `reviewer-fast` with `cwd=WORK_CWD` against `FIX_BASE...HEAD`'
require_text pi/agent/prompts/ship.md 'skipped-non-web'
require_text pi/agent/prompts/ship.md 'Read the `worktree-first` skill completely'
require_text pi/agent/prompts/ship.md 'never trust local `origin/HEAD` or guess main/master'
require_text pi/agent/prompts/ship.md 'stop with safe migration instructions rather than creating a derived shipping branch'
require_text pi/agent/prompts/ship.md 'GIT_COMMON_DIR="$(git -C "$WORK_CWD" rev-parse --path-format=absolute --git-common-dir)"'
require_text pi/agent/agents/reviewer-fast.md 'model: openai-codex/gpt-5.4-mini'
require_text pi/agent/agents/reviewer-fast.md 'Do not re-audit unchanged branch history.'
require_text pi/agent/prompts/vf.md 'if ! mkdir "$VF_DIR"'
require_text pi/agent/prompts/vf.md '`--qa-passed` requires an explicit `--qa-run-id`'
require_text pi/agent/prompts/vf.md 'refuse immediately when it is occupied'
require_text pi/agent/prompts/vf.md 'Verification normally requires an existing linked worktree'
require_text pi/agent/prompts/pr.md 'PR_LOCK="$GIT_COMMON_DIR/pi-pr.lock"'
require_text pi/agent/prompts/pr.md 'git ls-remote --symref origin HEAD'
require_text pi/agent/prompts/pr.md 'already-exists response'
require_text pi/agent/prompts/pr.md 'After a successful create or already-exists resolution'
require_text pi/agent/prompts/implement.md 'creates a new linked worktree from `origin/<default-branch>` by default'
require_text pi/agent/prompts/loop.md 'cwd=WORK_CWD'
require_text pi/agent/prompts/qa.md 'QA requires an existing linked feature worktree by default'
require_text pi/agent/prompts/qa.md 'worktree add -b ... "$path" "origin/$DEFAULT_BRANCH"'
require_text pi/agent/prompts/worktree.md 'Preserve the worktree'
require_text pi/agent/agents/worker.md 'do not edit unless the delegated task explicitly says the user supplied `--no-worktree`'
require_text pi/agent/skills/worktree-first/SKILL.md 'never stash, discard, copy, or auto-commit a dirty primary checkout'
require_text pi/agent/skills/worktree-first/SKILL.md 'git worktree add -b "$WORK_BRANCH" "$WORK_CWD" "origin/$DEFAULT_BRANCH"'
require_text pi/agent/skills/worktree-first/SKILL.md 'never use the caller'"'"'s `HEAD` or a local default branch as the start point'
require_text pi/agent/skills/worktree-first/SKILL.md 'Use `WORK_CWD` as `cwd` for every scout, planner, worker, reviewer, browser agent'
require_text pi/agent/APPEND_SYSTEM.md 'based only on the freshly fetched `origin/<default-branch>` tip'
require_text scripts/setup-pi.sh 'pi/agent/APPEND_SYSTEM.md'
require_text scripts/tmux-worktree-window.sh 'origin_default_branch()'
require_text scripts/tmux-worktree-window.sh 'ls-remote --symref origin HEAD'
require_text scripts/tmux-worktree-window.sh 'git -C "$repo_path" worktree add -b "$branch" "$worktree_path" "origin/$default_branch"'
require_text scripts/tmux-worktree-kill.sh 'worktree remove refused:'
require_text pi/agent/skills/worktree-first/SKILL.md 'Never force-remove a dirty worktree.'

printf 'PASS: %d  FAIL: %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
