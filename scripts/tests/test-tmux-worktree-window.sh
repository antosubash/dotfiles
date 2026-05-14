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

summary
