#!/usr/bin/env bash
# Tests for scripts/tmux-worktree-window.sh
# Run: bash scripts/tests/test-tmux-worktree-window.sh

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/tmux-worktree-window.sh"

PASS=0
FAIL=0
FAILURES=()
TEST_NAME=""

cleanup_on_exit() {
    [ -n "${TMPDIR_ROOT:-}" ] && [ -d "$TMPDIR_ROOT" ] && rm -rf "$TMPDIR_ROOT"
}
trap cleanup_on_exit EXIT

setup_test() {
    TEST_NAME="$1"
    TMPDIR_ROOT="$(mktemp -d)"
    FAKE_BIN="$TMPDIR_ROOT/bin"
    mkdir -p "$FAKE_BIN"
    TMUX_LOG="$TMPDIR_ROOT/tmux.log"
    : > "$TMUX_LOG"

    cat > "$FAKE_BIN/tmux" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMUX_LOG"
EOF
    chmod +x "$FAKE_BIN/tmux"

    ORIG_PATH="$PATH"
    export PATH="$FAKE_BIN:$PATH"
    cd "$TMPDIR_ROOT"
}

teardown_test() {
    cd /
    export PATH="$ORIG_PATH"
    rm -rf "$TMPDIR_ROOT"
}

assert_eq() {
    local expected="$1" actual="$2" label="${3:-}"
    if [ "$expected" = "$actual" ]; then
        PASS=$((PASS+1))
    else
        FAIL=$((FAIL+1))
        FAILURES+=("$TEST_NAME: $label: expected [$expected] got [$actual]")
    fi
}

assert_contains() {
    local haystack="$1" needle="$2" label="${3:-}"
    case "$haystack" in
        *"$needle"*) PASS=$((PASS+1)) ;;
        *)
            FAIL=$((FAIL+1))
            FAILURES+=("$TEST_NAME: $label: [$haystack] does not contain [$needle]")
            ;;
    esac
}

assert_tmux_log_contains() {
    assert_contains "$(cat "$TMUX_LOG")" "$1" "${2:-tmux log}"
}

source_script() {
    # shellcheck disable=SC1090
    _TMUX_WORKTREE_SOURCE_ONLY=1 . "$SCRIPT"
}

summary() {
    echo "------"
    echo "PASS: $PASS  FAIL: $FAIL"
    if [ "$FAIL" -gt 0 ]; then
        printf '  %s\n' "${FAILURES[@]}"
        exit 1
    fi
    exit 0
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

make_repo() {
    # Creates a real git repo with one commit at $1.
    local dir="$1"
    mkdir -p "$dir"
    git -C "$dir" init -q -b main
    git -C "$dir" config user.email t@t
    git -C "$dir" config user.name t
    : > "$dir/README"
    git -C "$dir" add README
    git -C "$dir" commit -q -m init
}

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
    # Make an "origin" repo with a branch, then clone it
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

summary
