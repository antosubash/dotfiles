#!/usr/bin/env bash
# Tests for scripts/tmux-worktree-window.sh
# Run: bash scripts/tests/test-tmux-worktree-window.sh

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/tmux-worktree-window.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

# Install a fake `gh` that returns canned output for `gh pr view N ...`.
# Usage: install_fake_gh '<pr_num>:<head_ref>' ...
# Special: '<pr_num>:!<exit_code>:<msg>' makes that PR fail with msg on stderr.
# NOTE: the mapping is word-split on whitespace, so values must be single tokens.
install_fake_gh() {
    local mapping="$*"
    cat > "$FAKE_BIN/gh" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "pr" ] && [ "\$2" = "view" ]; then
    num="\$3"
    for entry in $mapping; do
        key="\${entry%%:*}"
        val="\${entry#*:}"
        if [ "\$key" = "\$num" ]; then
            case "\$val" in
                !*)
                    code="\${val#!}"; code="\${code%%:*}"
                    msg="\${val#!*:}"
                    printf '%s\n' "\$msg" >&2
                    exit "\$code"
                    ;;
                *)
                    printf '%s\n' "\$val"
                    exit 0
                    ;;
            esac
        fi
    done
    printf 'no such PR: %s\n' "\$num" >&2
    exit 1
fi
exit 0
EOF
    chmod +x "$FAKE_BIN/gh"
}

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

test_sanitize_name() {
    setup_test "sanitize_name"
    source_script

    assert_eq "feature-foo"      "$(sanitize_name 'feature/foo')"      "slash → dash"
    assert_eq "a-b-c"            "$(sanitize_name 'a/b/c')"            "multiple slashes"
    assert_eq "bugfix-ABC-123"   "$(sanitize_name 'bugfix/ABC-123')"   "preserves alnum and dash"
    assert_eq "ok.v1_x"          "$(sanitize_name 'ok.v1_x')"          "preserves . and _"
    assert_eq "weird-name"       "$(sanitize_name 'weird   name')"     "collapses runs"
    assert_eq "trimmed"          "$(sanitize_name '--trimmed--')"      "trims edges"
    assert_eq ""                 "$(sanitize_name '///')"              "all-bad → empty"
    assert_eq ""                 "$(sanitize_name '')"                 "empty stays empty"
    assert_eq "a-b"              "$(sanitize_name 'a$b')"              "special char → dash"

    teardown_test
}

test_sanitize_name

test_main_toplevel_in_repo() {
    setup_test "main_toplevel in plain repo"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    local top
    top=$(main_toplevel "$TMPDIR_ROOT/repo")
    assert_eq "$TMPDIR_ROOT/repo" "$top" "toplevel matches"
    teardown_test
}

test_main_toplevel_in_subdir() {
    setup_test "main_toplevel from subdir"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    mkdir -p "$TMPDIR_ROOT/repo/sub/dir"
    local top
    top=$(main_toplevel "$TMPDIR_ROOT/repo/sub/dir")
    assert_eq "$TMPDIR_ROOT/repo" "$top" "toplevel from subdir"
    teardown_test
}

test_main_toplevel_from_worktree() {
    setup_test "main_toplevel from inside a worktree"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b wt "$TMPDIR_ROOT/repo/.worktrees/wt" >/dev/null 2>&1
    local top
    top=$(main_toplevel "$TMPDIR_ROOT/repo/.worktrees/wt")
    assert_eq "$TMPDIR_ROOT/repo" "$top" "toplevel from worktree resolves to main"
    teardown_test
}

test_main_toplevel_not_repo() {
    setup_test "main_toplevel outside a repo"
    source_script
    mkdir -p "$TMPDIR_ROOT/plain"
    if main_toplevel "$TMPDIR_ROOT/plain" >/dev/null 2>&1; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected non-zero exit")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_main_toplevel_in_repo
test_main_toplevel_in_subdir
test_main_toplevel_from_worktree
test_main_toplevel_not_repo

test_ensure_worktree_new_branch() {
    setup_test "ensure_worktree creates a new branch"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    local wt="$TMPDIR_ROOT/repo/.worktrees/new-feat"
    ensure_worktree "$TMPDIR_ROOT/repo" "new-feat" "$wt"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    # Branch should now exist locally
    if git -C "$TMPDIR_ROOT/repo" show-ref --verify --quiet refs/heads/new-feat; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: new-feat branch not created")
    fi
    teardown_test
}

test_ensure_worktree_existing_local_branch() {
    setup_test "ensure_worktree uses existing local branch"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" branch existing
    local wt="$TMPDIR_ROOT/repo/.worktrees/existing"
    ensure_worktree "$TMPDIR_ROOT/repo" "existing" "$wt"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    # Branch HEAD in the worktree must match the local branch
    local wt_head main_head
    wt_head=$(git -C "$wt" rev-parse HEAD)
    main_head=$(git -C "$TMPDIR_ROOT/repo" rev-parse existing)
    assert_eq "$main_head" "$wt_head" "worktree on existing branch"
    teardown_test
}

test_ensure_worktree_from_origin() {
    setup_test "ensure_worktree pulls branch from origin"
    source_script
    make_repo "$TMPDIR_ROOT/origin"
    git -C "$TMPDIR_ROOT/origin" checkout -q -b remote-feat
    : > "$TMPDIR_ROOT/origin/file"
    git -C "$TMPDIR_ROOT/origin" add file
    git -C "$TMPDIR_ROOT/origin" commit -q -m feat
    git -C "$TMPDIR_ROOT/origin" checkout -q main
    git clone -q "$TMPDIR_ROOT/origin" "$TMPDIR_ROOT/clone"
    git -C "$TMPDIR_ROOT/clone" fetch -q origin
    local wt="$TMPDIR_ROOT/clone/.worktrees/remote-feat"
    ensure_worktree "$TMPDIR_ROOT/clone" "remote-feat" "$wt"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    # Local branch should now exist, tracking origin/remote-feat
    if git -C "$TMPDIR_ROOT/clone" show-ref --verify --quiet refs/heads/remote-feat; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: local branch not created from origin")
    fi
    teardown_test
}

test_ensure_worktree_idempotent() {
    setup_test "ensure_worktree is idempotent when path exists"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    local wt="$TMPDIR_ROOT/repo/.worktrees/x"
    ensure_worktree "$TMPDIR_ROOT/repo" "x" "$wt"
    # Second call should succeed without trying to add again
    if ensure_worktree "$TMPDIR_ROOT/repo" "x" "$wt" 2>"$TMPDIR_ROOT/err"; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: second call failed: $(cat "$TMPDIR_ROOT/err")")
    fi
    teardown_test
}

test_ensure_worktree_failure_surfaces() {
    setup_test "ensure_worktree surfaces git errors"
    source_script
    make_repo "$TMPDIR_ROOT/repo"
    # main branch is already checked out in the main worktree — adding it again fails
    local wt="$TMPDIR_ROOT/repo/.worktrees/main"
    if ensure_worktree "$TMPDIR_ROOT/repo" "main" "$wt" 2>"$TMPDIR_ROOT/err"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected non-zero exit (branch already checked out)")
    else
        PASS=$((PASS+1))
    fi
    # Stderr should be non-empty
    if [ -s "$TMPDIR_ROOT/err" ]; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: expected git error on stderr")
    fi
    teardown_test
}

test_ensure_worktree_new_branch
test_ensure_worktree_existing_local_branch
test_ensure_worktree_from_origin
test_ensure_worktree_idempotent
test_ensure_worktree_failure_surfaces

test_spawn_creates_window() {
    setup_test "spawn creates worktree and tmux window"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "feature/foo"
    local wt="$TMPDIR_ROOT/repo/.worktrees/feature-foo"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    assert_tmux_log_contains "new-window -n feature-foo -c $wt" "new-window call"
    teardown_test
}

test_spawn_empty_branch_silent() {
    setup_test "spawn with empty branch is silent"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" ""
    assert_eq "" "$(cat "$TMUX_LOG")" "no tmux calls"
    teardown_test
}

test_spawn_invalid_sanitized_name() {
    setup_test "spawn with branch that sanitizes to empty shows message"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "///"
    assert_tmux_log_contains "display-message" "shows error"
    assert_tmux_log_contains "invalid branch name" "specific message"
    # No new-window call
    if grep -q "new-window" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not call new-window")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_spawn_outside_repo() {
    setup_test "spawn outside a git repo shows message"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" spawn "$TMPDIR_ROOT/plain" "foo"
    assert_tmux_log_contains "display-message" "shows error"
    assert_tmux_log_contains "not a git repo" "specific message"
    teardown_test
}

test_spawn_git_failure_displays_error() {
    setup_test "spawn surfaces git worktree add failure"
    make_repo "$TMPDIR_ROOT/repo"
    # main branch is already checked out in the main worktree — adding it again fails
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "main"
    assert_tmux_log_contains "display-message" "shows error"
    # No new-window because the add failed
    if grep -q "new-window" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not call new-window")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_spawn_reuses_existing_worktree() {
    setup_test "spawn opens window when worktree already exists"
    make_repo "$TMPDIR_ROOT/repo"
    git -C "$TMPDIR_ROOT/repo" worktree add -b reused "$TMPDIR_ROOT/repo/.worktrees/reused" >/dev/null 2>&1
    "$SCRIPT" spawn "$TMPDIR_ROOT/repo" "reused"
    assert_tmux_log_contains "new-window -n reused -c $TMPDIR_ROOT/repo/.worktrees/reused" "opens window"
    teardown_test
}

test_spawn_creates_window
test_spawn_empty_branch_silent
test_spawn_invalid_sanitized_name
test_spawn_outside_repo
test_spawn_git_failure_displays_error
test_spawn_reuses_existing_worktree

test_prompt_outside_repo() {
    setup_test "prompt outside repo shows message"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" prompt "$TMPDIR_ROOT/plain"
    assert_tmux_log_contains "display-message" "shows message"
    assert_tmux_log_contains "not a git repo" "specific message"
    # No command-prompt issued
    if grep -q "command-prompt" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not issue command-prompt")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_prompt_in_repo_issues_command_prompt() {
    setup_test "prompt in repo issues command-prompt with run-shell callback"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" prompt "$TMPDIR_ROOT/repo"
    local log
    log="$(cat "$TMUX_LOG")"
    assert_contains "$log" "command-prompt -p branch:" "command-prompt issued"
    assert_contains "$log" "run-shell"               "run-shell in callback"
    assert_contains "$log" "$SCRIPT spawn"           "spawn invocation"
    assert_contains "$log" "$TMPDIR_ROOT/repo"       "pane path baked in"
    assert_contains "$log" "%%"                      "branch placeholder"
    teardown_test
}

test_prompt_outside_repo
test_prompt_in_repo_issues_command_prompt

# --- PR flow ---

# Builds a bare "remote" repo and pushes a commit to refs/pull/N/head so that
# `git fetch origin refs/pull/N/head:...` works without touching the network.
# The PR's head ref name is metadata returned by the fake gh; the remote
# doesn't need a branch by that name for the fetch to succeed.
make_remote_with_pr() {
    local remote="$1" pr_num="$2"
    git init -q --bare "$remote"
    local seed="$TMPDIR_ROOT/seed-$pr_num"
    git init -q -b main "$seed"
    git -C "$seed" config user.email t@t
    git -C "$seed" config user.name t
    : > "$seed/README"; git -C "$seed" add README; git -C "$seed" commit -q -m base
    : > "$seed/feature"; git -C "$seed" add feature; git -C "$seed" commit -q -m feat
    git -C "$seed" push -q "$remote" "HEAD:refs/pull/$pr_num/head"
    rm -rf "$seed"
}

make_clone() {
    local remote="$1" target="$2"
    git clone -q "$remote" "$target"
    git -C "$target" config user.email t@t
    git -C "$target" config user.name t
}

test_spawn_pr_rejects_non_numeric() {
    setup_test "spawn-pr rejects non-numeric input"
    install_fake_gh "42:feature/foo"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" "abc"
    assert_tmux_log_contains "display-message" "shows error"
    assert_tmux_log_contains "invalid PR number" "specific message"
    if grep -q "new-window" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not call new-window")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_spawn_pr_empty_silent() {
    setup_test "spawn-pr with empty input is silent"
    install_fake_gh "42:feature/foo"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" ""
    assert_eq "" "$(cat "$TMUX_LOG")" "no tmux calls"
    teardown_test
}

test_spawn_pr_outside_repo() {
    setup_test "spawn-pr outside a git repo shows message"
    install_fake_gh "42:feature/foo"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/plain" "42"
    assert_tmux_log_contains "not a git repo" "specific message"
    teardown_test
}

test_spawn_pr_gh_failure_surfaces() {
    setup_test "spawn-pr surfaces gh failure"
    install_fake_gh "42:!1:PR-unreachable"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" "42"
    assert_tmux_log_contains "display-message" "shows error"
    assert_tmux_log_contains "gh pr view #42 failed" "error prefix"
    assert_tmux_log_contains "PR-unreachable" "gh stderr surfaced"
    teardown_test
}

test_spawn_pr_creates_worktree_and_window() {
    setup_test "spawn-pr fetches PR head and opens window"
    install_fake_gh "42:feature/foo"
    make_remote_with_pr "$TMPDIR_ROOT/remote.git" "42"
    make_clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" "42"
    local wt="$TMPDIR_ROOT/repo/.worktrees/pr-42-feature-foo"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing"); }
    if git -C "$TMPDIR_ROOT/repo" show-ref --verify --quiet "refs/heads/pr-42-feature-foo"; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: local pr branch not created")
    fi
    assert_tmux_log_contains "new-window -n pr-42-feature-foo -c $wt" "opens window"
    teardown_test
}

test_spawn_pr_idempotent_when_worktree_exists() {
    setup_test "spawn-pr reopens window when worktree already exists"
    install_fake_gh "42:feature/foo"
    make_remote_with_pr "$TMPDIR_ROOT/remote.git" "42"
    make_clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" "42"
    : > "$TMUX_LOG"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" "42"
    assert_tmux_log_contains "new-window -n pr-42-feature-foo" "second call still opens window"
    if grep -q "display-message" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not error on second call")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_spawn_pr_sanitizes_head_ref_with_slashes() {
    setup_test "spawn-pr sanitizes head ref containing slashes"
    install_fake_gh "7:bugfix/ABC-123"
    make_remote_with_pr "$TMPDIR_ROOT/remote.git" "7"
    make_clone "$TMPDIR_ROOT/remote.git" "$TMPDIR_ROOT/repo"
    "$SCRIPT" spawn-pr "$TMPDIR_ROOT/repo" "7"
    local wt="$TMPDIR_ROOT/repo/.worktrees/pr-7-bugfix-ABC-123"
    [ -d "$wt" ] && PASS=$((PASS+1)) || { FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: worktree dir missing at $wt"); }
    assert_tmux_log_contains "new-window -n pr-7-bugfix-ABC-123 -c $wt" "opens window with sanitized name"
    teardown_test
}

test_prompt_pr_outside_repo() {
    setup_test "prompt-pr outside repo shows message"
    install_fake_gh "1:foo"
    mkdir -p "$TMPDIR_ROOT/plain"
    "$SCRIPT" prompt-pr "$TMPDIR_ROOT/plain"
    assert_tmux_log_contains "display-message" "shows message"
    assert_tmux_log_contains "not a git repo" "specific message"
    if grep -q "command-prompt" "$TMUX_LOG"; then
        FAIL=$((FAIL+1)); FAILURES+=("$TEST_NAME: should not issue command-prompt")
    else
        PASS=$((PASS+1))
    fi
    teardown_test
}

test_prompt_pr_in_repo_issues_command_prompt() {
    setup_test "prompt-pr in repo issues command-prompt with run-shell callback"
    install_fake_gh "1:foo"
    make_repo "$TMPDIR_ROOT/repo"
    "$SCRIPT" prompt-pr "$TMPDIR_ROOT/repo"
    local log
    log="$(cat "$TMUX_LOG")"
    assert_contains "$log" "command-prompt -p PR #:" "PR command-prompt issued"
    assert_contains "$log" "run-shell"                "run-shell in callback"
    assert_contains "$log" "$SCRIPT spawn-pr"         "spawn-pr invocation"
    assert_contains "$log" "$TMPDIR_ROOT/repo"        "pane path baked in"
    assert_contains "$log" "%%"                       "pr-number placeholder"
    teardown_test
}

test_spawn_pr_rejects_non_numeric
test_spawn_pr_empty_silent
test_spawn_pr_outside_repo
test_spawn_pr_gh_failure_surfaces
test_spawn_pr_creates_worktree_and_window
test_spawn_pr_idempotent_when_worktree_exists
test_spawn_pr_sanitizes_head_ref_with_slashes
test_prompt_pr_outside_repo
test_prompt_pr_in_repo_issues_command_prompt

summary
