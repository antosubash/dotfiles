#!/usr/bin/env bash
# Tests for scripts/cleanup-merged-worktrees.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$(cd "$HERE/.." && pwd)/cleanup-merged-worktrees.sh"
# shellcheck disable=SC1091
. "$HERE/lib.sh"

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); FAILURES+=("$TEST_NAME: $1"); }

install_fake_gh() {
    export GH_FIXTURES="$TMPDIR_ROOT/gh-fixtures"
    mkdir -p "$GH_FIXTURES"
    cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
case "$1 $2" in
    "auth status") exit 0 ;;
    "repo view") printf '%s\n' owner/repo; exit 0 ;;
    "pr list")
        shift 2
        branch=""
        while [ "$#" -gt 0 ]; do
            if [ "$1" = "--head" ]; then branch="$2"; shift; fi
            shift
        done
        fixture="$GH_FIXTURES/$branch.json"
        if [ -f "$fixture" ]; then cat "$fixture"; else printf '[]\n'; fi
        ;;
    *) exit 1 ;;
esac
EOF
    chmod +x "$FAKE_BIN/gh"
}

add_worktree_commit() {
    local repo="$1" name="$2" path
    path="$repo/.worktrees/$name"
    git -C "$repo" worktree add -q -b "$name" "$path"
    printf '%s\n' "$name" > "$path/$name.txt"
    git -C "$path" add "$name.txt"
    git -C "$path" commit -q -m "$name"
    git -C "$path" rev-parse HEAD
}

write_pr() {
    local branch="$1" number="$2" merged_at="$3" head="$4"
    printf '[{"number":%s,"mergedAt":"%s","url":"https://example.test/pr/%s","headRefOid":"%s"}]\n' \
        "$number" "$merged_at" "$number" "$head" > "$GH_FIXTURES/$branch.json"
}

test_removes_only_clean_exact_old_merged_pr() {
    setup_test "removes only clean exact old merged PR worktree"
    install_fake_gh
    make_repo "$TMPDIR_ROOT/repo"
    local old recent old_head recent_head dirty_head advanced_head old_parent output
    old="$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)"
    recent="$(date -u -d '2 days ago' +%Y-%m-%dT%H:%M:%SZ)"

    old_head="$(add_worktree_commit "$TMPDIR_ROOT/repo" merged-old)"
    recent_head="$(add_worktree_commit "$TMPDIR_ROOT/repo" merged-recent)"
    dirty_head="$(add_worktree_commit "$TMPDIR_ROOT/repo" merged-dirty)"
    advanced_head="$(add_worktree_commit "$TMPDIR_ROOT/repo" merged-advanced)"
    old_parent="$(git -C "$TMPDIR_ROOT/repo/.worktrees/merged-advanced" rev-parse HEAD^)"
    : > "$TMPDIR_ROOT/repo/.worktrees/merged-dirty/untracked"
    : > "$TMPDIR_ROOT/repo/.worktrees/merged-advanced/newer"
    git -C "$TMPDIR_ROOT/repo/.worktrees/merged-advanced" add newer
    git -C "$TMPDIR_ROOT/repo/.worktrees/merged-advanced" commit -q -m newer
    add_worktree_commit "$TMPDIR_ROOT/repo" no-pr >/dev/null

    write_pr merged-old 1 "$old" "$old_head"
    write_pr merged-recent 2 "$recent" "$recent_head"
    write_pr merged-dirty 3 "$old" "$dirty_head"
    write_pr merged-advanced 4 "$old" "$advanced_head"
    # The fixture intentionally points at a SHA older than the current branch.
    python3 - "$GH_FIXTURES/merged-advanced.json" "$old_parent" <<'PY'
import json,sys
p=sys.argv[1]; data=json.load(open(p)); data[0]["headRefOid"]=sys.argv[2]
open(p,"w").write(json.dumps(data))
PY

    output="$("$SCRIPT" --repo "$TMPDIR_ROOT/repo" --days 14)"
    [ ! -e "$TMPDIR_ROOT/repo/.worktrees/merged-old" ] && pass || fail "old merged worktree was not removed"
    git -C "$TMPDIR_ROOT/repo" show-ref --verify --quiet refs/heads/merged-old && pass || fail "local branch was deleted"
    [ -d "$TMPDIR_ROOT/repo/.worktrees/merged-recent" ] && pass || fail "recent merged worktree was removed"
    [ -e "$TMPDIR_ROOT/repo/.worktrees/merged-dirty/untracked" ] && pass || fail "dirty worktree was removed"
    [ -d "$TMPDIR_ROOT/repo/.worktrees/merged-advanced" ] && pass || fail "advanced branch worktree was removed"
    [ -d "$TMPDIR_ROOT/repo/.worktrees/no-pr" ] && pass || fail "worktree without PR was removed"
    assert_contains "$output" "summary: removed=1 kept=4 errors=0" "summary"
    teardown_test
}

test_dry_run_preserves_candidate() {
    setup_test "dry run preserves old merged candidate"
    install_fake_gh
    make_repo "$TMPDIR_ROOT/repo"
    local old head output
    old="$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)"
    head="$(add_worktree_commit "$TMPDIR_ROOT/repo" merged-old)"
    write_pr merged-old 1 "$old" "$head"
    output="$("$SCRIPT" --repo "$TMPDIR_ROOT/repo" --days 14 --dry-run)"
    [ -d "$TMPDIR_ROOT/repo/.worktrees/merged-old" ] && pass || fail "dry run removed worktree"
    assert_contains "$output" "would-remove" "candidate reported"
    assert_contains "$output" "dry-run" "dry-run summary"
    teardown_test
}

test_selected_and_caller_worktrees_are_preserved() {
    setup_test "selected and caller worktrees are preserved"
    install_fake_gh
    make_repo "$TMPDIR_ROOT/repo"
    local old head wt output
    old="$(date -u -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ)"
    head="$(add_worktree_commit "$TMPDIR_ROOT/repo" merged-old)"
    wt="$TMPDIR_ROOT/repo/.worktrees/merged-old"
    write_pr merged-old 1 "$old" "$head"

    output="$("$SCRIPT" --repo "$wt" --days 14)"
    [ -d "$wt" ] && pass || fail "selected worktree was removed"
    assert_contains "$output" "selected/current worktree" "selected worktree reason"

    output="$(cd "$wt" && "$SCRIPT" --repo "$TMPDIR_ROOT/repo" --days 14)"
    [ -d "$wt" ] && pass || fail "caller worktree was removed"
    assert_contains "$output" "selected/current worktree" "caller worktree reason"
    teardown_test
}

test_invalid_days_fails() {
    setup_test "invalid days fails"
    if "$SCRIPT" --days nope >"$TMPDIR_ROOT/out" 2>"$TMPDIR_ROOT/err"; then
        fail "invalid days unexpectedly succeeded"
    else
        pass
    fi
    assert_contains "$(cat "$TMPDIR_ROOT/err")" "--days must be" "validation message"
    if "$SCRIPT" --days 500000000000000000 >"$TMPDIR_ROOT/out" 2>"$TMPDIR_ROOT/err"; then
        fail "overflowing days unexpectedly succeeded"
    else
        pass
    fi
    assert_contains "$(cat "$TMPDIR_ROOT/err")" "must not exceed 36500" "overflow bound"
    teardown_test
}

test_removes_only_clean_exact_old_merged_pr
test_dry_run_preserves_candidate
test_selected_and_caller_worktrees_are_preserved
test_invalid_days_fails
summary
