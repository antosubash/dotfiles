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
    mkdir -p "$TMPDIR_ROOT/ws"
    git clone -q "$TMPDIR_ROOT/remotes/$name.git" "$TMPDIR_ROOT/ws/$name"
    git -C "$TMPDIR_ROOT/ws/$name" config user.email t@t
    git -C "$TMPDIR_ROOT/ws/$name" config user.name t
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

summary
