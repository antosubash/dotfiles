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
summary
