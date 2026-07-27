#!/usr/bin/env bash
# Tests for scripts/repos-sync.sh
SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/repos-sync.sh"
# shellcheck source=./lib.sh
. "$(dirname "$0")/lib.sh"

load_script() {
    # shellcheck disable=SC1090
    REPOS_SYNC_SOURCE_ONLY=1 . "$SCRIPT"
}

# --- fixtures -------------------------------------------------------------
# make_remote NAME [DEFAULT_BRANCH]  -> creates $TMPDIR_ROOT/remotes/NAME.git
make_remote() {
    local name="$1" def="${2:-main}" seed="$TMPDIR_ROOT/seed-$1"
    mkdir -p "$TMPDIR_ROOT/remotes"
    git init -q --bare -b "$def" "$TMPDIR_ROOT/remotes/$name.git"
    git init -q -b "$def" "$seed"
    git -C "$seed" config user.email t@t
    git -C "$seed" config user.name t
    echo one > "$seed/file"
    git -C "$seed" add file
    git -C "$seed" commit -q -m init
    git -C "$seed" remote add origin "$TMPDIR_ROOT/remotes/$name.git"
    git -C "$seed" push -q -u origin "$def"
}

# clone_repo NAME -> clones into $TMPDIR_ROOT/ws/NAME
clone_repo() {
    local name="$1"
    local dir="$TMPDIR_ROOT/ws/$name"
    mkdir -p "$TMPDIR_ROOT/ws"
    git clone -q "$TMPDIR_ROOT/remotes/$name.git" "$dir"
    git -C "$dir" config user.email t@t
    git -C "$dir" config user.name t
    # Mirror what Claude Code puts in .git/info/exclude, so worktrees living
    # under .claude/worktrees/ do not make the parent repo look dirty.
    echo '**/.claude/worktrees/' >> "$dir/.git/info/exclude"
}

# --- tests ----------------------------------------------------------------
setup_test "discover_repos finds git repos and skips plain dirs"
load_script
make_remote alpha
clone_repo alpha
mkdir -p "$TMPDIR_ROOT/ws/not-a-repo"
ROOT="$TMPDIR_ROOT/ws"
FILTERS=()
out="$(discover_repos)"
assert_contains "$out" "/ws/alpha" "alpha discovered"
assert_not_contains "$out" "not-a-repo" "plain dir skipped"
teardown_test

setup_test "discover_repos honours name filters"
load_script
make_remote alpha; clone_repo alpha
make_remote beta;  clone_repo beta
ROOT="$TMPDIR_ROOT/ws"
FILTERS=(beta)
out="$(discover_repos)"
assert_contains "$out" "/ws/beta" "beta kept"
assert_not_contains "$out" "/ws/alpha" "alpha filtered out"
teardown_test

setup_test "is_dirty detects tracked and untracked changes"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
is_dirty "$r" && s=dirty || s=clean
assert_eq "clean" "$s" "fresh clone is clean"
echo two > "$r/file"
is_dirty "$r" && s=dirty || s=clean
assert_eq "dirty" "$s" "tracked edit is dirty"
git -C "$r" checkout -q -- file
touch "$r/newfile"
is_dirty "$r" && s=dirty || s=clean
assert_eq "dirty" "$s" "untracked file is dirty"
teardown_test

setup_test "default_branch reads origin/HEAD for non-main defaults"
load_script
make_remote gamma dev
clone_repo gamma
assert_eq "dev" "$(default_branch "$TMPDIR_ROOT/ws/gamma")" "dev default"
make_remote delta master
clone_repo delta
assert_eq "master" "$(default_branch "$TMPDIR_ROOT/ws/delta")" "master default"
teardown_test

setup_test "default_branch repairs a missing origin/HEAD"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
git -C "$r" symbolic-ref --delete refs/remotes/origin/HEAD
assert_eq "" "$(git -C "$r" symbolic-ref --quiet --short refs/remotes/origin/HEAD)" "head unset"
assert_eq "main" "$(default_branch "$r")" "recovered"
assert_eq "origin/main" "$(git -C "$r" symbolic-ref --quiet --short refs/remotes/origin/HEAD)" "head persisted"
teardown_test

setup_test "has_origin is false for a remote-less repo"
load_script
mkdir -p "$TMPDIR_ROOT/ws"
make_repo "$TMPDIR_ROOT/ws/solo"
has_origin "$TMPDIR_ROOT/ws/solo" && s=yes || s=no
assert_eq "no" "$s" "no origin"
assert_eq "" "$(default_branch "$TMPDIR_ROOT/ws/solo")" "no default branch"
teardown_test

status_of() { printf '%s' "${1%%|*}"; }

setup_test "sync_repo leaves a dirty repo untouched"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
git -C "$r" switch -q -c feature
echo edited > "$r/file"
out="$(sync_repo "$r" main)"
assert_eq "dirty" "$(status_of "$out")" "reported dirty"
assert_eq "feature" "$(git -C "$r" symbolic-ref --short HEAD)" "still on feature"
assert_eq "edited" "$(cat "$r/file")" "edit preserved"
teardown_test

setup_test "sync_repo switches a clean feature branch to default and keeps the ref"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
git -C "$r" switch -q -c feature
echo work > "$r/file"; git -C "$r" commit -qam work
out="$(sync_repo "$r" main)"
assert_eq "switched" "$(status_of "$out")" "reported switched"
assert_eq "main" "$(git -C "$r" symbolic-ref --short HEAD)" "on main"
git -C "$r" show-ref --verify --quiet refs/heads/feature && s=kept || s=gone
assert_eq "kept" "$s" "feature branch ref kept"
teardown_test

setup_test "sync_repo fast-forwards a behind repo"
load_script
make_remote alpha; clone_repo alpha
seed="$TMPDIR_ROOT/seed-alpha"
echo more > "$seed/file"; git -C "$seed" commit -qam more; git -C "$seed" push -q origin main
r="$TMPDIR_ROOT/ws/alpha"
git -C "$r" fetch -q origin
out="$(sync_repo "$r" main)"
assert_eq "updated" "$(status_of "$out")" "reported updated"
assert_eq "more" "$(cat "$r/file")" "content advanced"
teardown_test

setup_test "sync_repo reports an up-to-date repo as current"
load_script
make_remote alpha; clone_repo alpha
out="$(sync_repo "$TMPDIR_ROOT/ws/alpha" main)"
assert_eq "current" "$(status_of "$out")" "reported current"
teardown_test

setup_test "sync_repo refuses to touch a diverged default branch"
load_script
make_remote alpha; clone_repo alpha
seed="$TMPDIR_ROOT/seed-alpha"
echo remote > "$seed/file"; git -C "$seed" commit -qam remote; git -C "$seed" push -q origin main
r="$TMPDIR_ROOT/ws/alpha"
echo local > "$r/other"; git -C "$r" add other; git -C "$r" commit -qm local
local_head="$(git -C "$r" rev-parse HEAD)"
git -C "$r" fetch -q origin
out="$(sync_repo "$r" main)"
assert_eq "diverged" "$(status_of "$out")" "reported diverged"
assert_eq "$local_head" "$(git -C "$r" rev-parse HEAD)" "HEAD unmoved"
teardown_test

setup_test "sync_repo will not fight a worktree holding the default branch"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
git -C "$r" switch -q -c feature
git -C "$r" worktree add -q "$r/.claude/worktrees/wt" main
out="$(sync_repo "$r" main)"
assert_eq "locked" "$(status_of "$out")" "reported locked"
assert_eq "feature" "$(git -C "$r" symbolic-ref --short HEAD)" "left on feature"
teardown_test

setup_test "sync_repo reports a remote-less repo"
load_script
mkdir -p "$TMPDIR_ROOT/ws"
make_repo "$TMPDIR_ROOT/ws/solo"
assert_eq "no-remote" "$(status_of "$(sync_repo "$TMPDIR_ROOT/ws/solo" "")")" "no remote"
teardown_test

summary
