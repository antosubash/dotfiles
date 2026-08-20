#!/usr/bin/env bash
# Tests for scripts/tmux-worktree-kill.sh
# Run: bash scripts/tests/test-tmux-worktree-kill.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/tmux-worktree-kill.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# --- tests ---

test_unknown_subcommand_fails() {
    setup_test "unknown subcommand"
    if "$SCRIPT" bogus 2>"$TMPDIR_ROOT/err"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected non-zero exit")
    else
        PASS=$((PASS+1))
    fi
    assert_contains "$(cat "$TMPDIR_ROOT/err")" "unknown" "stderr mentions unknown"
    teardown_test
}

test_unknown_subcommand_fails

test_prompt_outside_repo_uses_plain_confirm() {
    setup_test "prompt outside repo issues plain kill-window confirm"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" prompt "$TMPDIR_ROOT/plain" "@7"
    assert_tmux_log_contains "confirm-before" "uses confirm-before"
    assert_tmux_log_contains "kill-window -t '@7'" "kills the right window"
    assert_tmux_log_not_contains "worktree" "no worktree mention"
    teardown_test
}

test_prompt_in_main_repo_uses_plain_confirm() {
    setup_test "prompt in main repo (no worktree) issues plain confirm"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" prompt "$TMPDIR_ROOT/repo" "@3"
    assert_tmux_log_contains "confirm-before" "uses confirm-before"
    assert_tmux_log_contains "kill-window -t '@3'" "kills the right window"
    assert_tmux_log_not_contains "worktree" "no worktree mention"
    teardown_test
}

test_prompt_in_worktree_offers_remove() {
    setup_test "prompt inside a worktree offers worktree removal"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b feat "$TMPDIR_ROOT/repo/.worktrees/feat" >/dev/null 2>&1
    "$SCRIPT" prompt "$TMPDIR_ROOT/repo/.worktrees/feat" "@9"
    local log
    log="$(cat "$TMUX_LOG")"
    assert_contains "$log" "confirm-before" "uses confirm-before"
    assert_contains "$log" "remove clean worktree" "mentions safe worktree removal"
    assert_contains "$log" "$TMPDIR_ROOT/repo/.worktrees/feat" "worktree path baked in"
    assert_contains "$log" "run-shell" "callback uses run-shell"
    assert_contains "$log" "$SCRIPT remove" "callback invokes remove subcommand"
    assert_contains "$log" "@9" "window id baked in"
    teardown_test
}

test_prompt_from_subdir_of_worktree_offers_remove() {
    setup_test "prompt from a subdir of the worktree still detects it"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b feat "$TMPDIR_ROOT/repo/.worktrees/feat" >/dev/null 2>&1
    mkdir -p "$TMPDIR_ROOT/repo/.worktrees/feat/sub"
    "$SCRIPT" prompt "$TMPDIR_ROOT/repo/.worktrees/feat/sub" "@2"
    assert_tmux_log_contains "remove clean worktree" "mentions safe worktree removal"
    teardown_test
}

test_prompt_outside_repo_uses_plain_confirm
test_prompt_in_main_repo_uses_plain_confirm
test_prompt_in_worktree_offers_remove
test_prompt_from_subdir_of_worktree_offers_remove

test_remove_success_kills_window() {
    setup_test "remove succeeds, then kills window"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b feat "$TMPDIR_ROOT/repo/.worktrees/feat" >/dev/null 2>&1
    "$SCRIPT" remove "$TMPDIR_ROOT/repo" "$TMPDIR_ROOT/repo/.worktrees/feat" "@5"
    # Worktree directory should be gone
    if [ -e "$TMPDIR_ROOT/repo/.worktrees/feat" ]; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree path still exists")
    else
        PASS=$((PASS+1))
    fi
    assert_tmux_log_contains "kill-window -t @5" "kills the right window"
    assert_tmux_log_not_contains "display-message" "no error displayed"
    teardown_test
}

test_remove_preserves_dirty_worktree() {
    setup_test "remove preserves dirty worktree and window"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b feat "$TMPDIR_ROOT/repo/.worktrees/feat" >/dev/null 2>&1
    echo dirty > "$TMPDIR_ROOT/repo/.worktrees/feat/file"
    "$SCRIPT" remove "$TMPDIR_ROOT/repo" "$TMPDIR_ROOT/repo/.worktrees/feat" "@5"
    if [ -e "$TMPDIR_ROOT/repo/.worktrees/feat/file" ]; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: dirty worktree content was removed")
    fi
    assert_tmux_log_not_contains "kill-window" "leaves window alive"
    assert_tmux_log_contains "worktree remove refused" "displays refusal"
    teardown_test
}

test_remove_failure_does_not_kill_window() {
    setup_test "remove fails on missing worktree dir, leaves window alive"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" remove "$TMPDIR_ROOT/repo" "$TMPDIR_ROOT/repo/.worktrees/nope" "@5"
    assert_tmux_log_not_contains "kill-window" "leaves window alive on refusal"
    assert_tmux_log_contains "worktree remove refused" "displays refusal"
    teardown_test
}

test_remove_preserves_orphan_dir_with_no_metadata() {
    setup_test "remove preserves orphan worktree dir when metadata is gone"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b feat "$TMPDIR_ROOT/repo/.worktrees/feat" >/dev/null 2>&1
    echo dirty > "$TMPDIR_ROOT/repo/.worktrees/feat/file"
    # Simulate user's broken state: nuke .git/worktrees metadata but leave the
    # working directory on disk.
    rm -rf "$TMPDIR_ROOT/repo/.git/worktrees"
    "$SCRIPT" remove "$TMPDIR_ROOT/repo" "$TMPDIR_ROOT/repo/.worktrees/feat" "@5"
    if [ -e "$TMPDIR_ROOT/repo/.worktrees/feat/file" ]; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: orphan content was removed")
    fi
    assert_tmux_log_not_contains "kill-window" "leaves window alive"
    assert_tmux_log_contains "worktree remove refused" "displays refusal"
    teardown_test
}

test_prompt_orphan_dir_offers_remove() {
    setup_test "prompt on orphan worktree dir offers safe removal"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b feat "$TMPDIR_ROOT/repo/.worktrees/feat" >/dev/null 2>&1
    rm -rf "$TMPDIR_ROOT/repo/.git/worktrees"
    "$SCRIPT" prompt "$TMPDIR_ROOT/repo/.worktrees/feat" "@9"
    assert_tmux_log_contains "remove clean worktree" "prompts for safe worktree removal"
    assert_tmux_log_contains "$TMPDIR_ROOT/repo/.worktrees/feat" "worktree path baked in"
    assert_tmux_log_contains "$SCRIPT remove" "callback invokes remove subcommand"
    teardown_test
}

test_remove_success_kills_window
test_remove_preserves_dirty_worktree
test_remove_failure_does_not_kill_window
test_remove_preserves_orphan_dir_with_no_metadata
test_prompt_orphan_dir_offers_remove

summary
