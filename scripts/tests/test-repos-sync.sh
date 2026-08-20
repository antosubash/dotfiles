#!/usr/bin/env bash
# Tests for scripts/repos-sync.sh
# shellcheck disable=SC2034  # tests set globals (ROOT, FILTERS, PRUNE_WORKTREES, DRY_RUN) read by the sourced script
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

setup_test "sync_repo reports a switch that also fast-forwards as switched"
load_script
make_remote alpha; clone_repo alpha
seed="$TMPDIR_ROOT/seed-alpha"
echo more > "$seed/file"; git -C "$seed" commit -qam more; git -C "$seed" push -q origin main
r="$TMPDIR_ROOT/ws/alpha"
git -C "$r" switch -q -c feature
git -C "$r" fetch -q origin
out="$(sync_repo "$r" main)"
assert_eq "switched" "$(status_of "$out")" "branch move is not hidden by the ff"
assert_contains "$out" "feature -> main" "names the branch it moved off"
assert_contains "$out" "(ff " "still reports the fast-forward"
assert_eq "more" "$(cat "$r/file")" "content advanced"
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

# add_worktree REPO NAME BRANCH  — worktree at .claude/worktrees/NAME
add_worktree() {
    git -C "$1" worktree add -q -b "$3" "$1/.claude/worktrees/$2" 2>/dev/null
}

setup_test "list_worktrees skips the main working tree"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" wt1 topic
out="$(list_worktrees "$r")"
assert_eq "1" "$(printf '%s\n' "$out" | grep -c .)" "one entry"
assert_contains "$out" "refs/heads/topic" "branch reported"
assert_contains "$out" "worktrees/wt1" "path reported"
teardown_test

setup_test "worktree_removable accepts an ancestor-merged branch"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" wt1 topic
reason="$(worktree_removable "$r" topic main)" && ok=yes || ok=no
assert_eq "yes" "$ok" "removable"
assert_eq "merged" "$reason" "ancestor reason"
teardown_test

setup_test "worktree_removable accepts a squash-merged branch"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"; seed="$TMPDIR_ROOT/seed-alpha"
add_worktree "$r" wt1 topic
w="$r/.claude/worktrees/wt1"
printf 'a\n' > "$w/f1"; git -C "$w" add f1; git -C "$w" commit -qm c1
printf 'b\n' > "$w/f2"; git -C "$w" add f2; git -C "$w" commit -qm c2
# land the same content on the remote default as ONE squashed commit
printf 'a\n' > "$seed/f1"; printf 'b\n' > "$seed/f2"
git -C "$seed" add f1 f2; git -C "$seed" commit -qm squashed
git -C "$seed" push -q origin main
git -C "$r" fetch -q origin
git -C "$r" merge-base --is-ancestor topic origin/main 2>/dev/null && anc=yes || anc=no
assert_eq "no" "$anc" "not an ancestor, so ancestry alone would miss it"
reason="$(worktree_removable "$r" topic main)" && ok=yes || ok=no
assert_eq "yes" "$ok" "removable"
assert_eq "squashed" "$reason" "squash reason"
teardown_test

setup_test "worktree_removable rejects a genuinely unmerged branch"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" wt1 topic
w="$r/.claude/worktrees/wt1"
printf 'unique\n' > "$w/only-here"; git -C "$w" add only-here; git -C "$w" commit -qm unlanded
worktree_removable "$r" topic main >/dev/null && ok=yes || ok=no
assert_eq "no" "$ok" "kept"
teardown_test

setup_test "classify_worktree keeps dirty, untracked-only and detached worktrees"
load_script
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"

add_worktree "$r" dirty topicd
echo edit > "$r/.claude/worktrees/dirty/file"
out="$(classify_worktree "$r" "$r/.claude/worktrees/dirty" refs/heads/topicd main)"
assert_eq "keep|dirty" "$out" "tracked edit kept"

add_worktree "$r" untracked topicu
touch "$r/.claude/worktrees/untracked/stray"
out="$(classify_worktree "$r" "$r/.claude/worktrees/untracked" refs/heads/topicu main)"
assert_eq "keep|dirty" "$out" "untracked-only kept"

git -C "$r" worktree add -q --detach "$r/.claude/worktrees/det" main
out="$(classify_worktree "$r" "$r/.claude/worktrees/det" "" main)"
assert_eq "keep|detached" "$out" "detached kept"

add_worktree "$r" clean topicc
out="$(classify_worktree "$r" "$r/.claude/worktrees/clean" refs/heads/topicc main)"
assert_eq "remove|merged" "$out" "clean merged removable"
teardown_test

setup_test "cleanup_worktrees only lists when --prune-worktrees is not set"
load_script
PRUNE_WORKTREES=0; DRY_RUN=0
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" wt1 topic
out="$(cleanup_worktrees "$r" main)"
assert_contains "$out" "removable|" "listed as removable"
assert_not_contains "$out" "removed|" "nothing removed"
[ -d "$r/.claude/worktrees/wt1" ] && s=present || s=gone
assert_eq "present" "$s" "worktree still on disk"
teardown_test

setup_test "cleanup_worktrees removes the worktree and its branch when pruning"
load_script
PRUNE_WORKTREES=1; DRY_RUN=0
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" wt1 topic
out="$(cleanup_worktrees "$r" main)"
assert_contains "$out" "removed|" "reported removed"
[ -d "$r/.claude/worktrees/wt1" ] && s=present || s=gone
assert_eq "gone" "$s" "directory removed"
git -C "$r" show-ref --verify --quiet refs/heads/topic && s=present || s=gone
assert_eq "gone" "$s" "branch deleted"
teardown_test

setup_test "cleanup_worktrees deletes a squash-merged branch with -D"
load_script
PRUNE_WORKTREES=1; DRY_RUN=0
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"; seed="$TMPDIR_ROOT/seed-alpha"
add_worktree "$r" wt1 topic
w="$r/.claude/worktrees/wt1"
printf 'a\n' > "$w/f1"; git -C "$w" add f1; git -C "$w" commit -qm c1
printf 'a\n' > "$seed/f1"; git -C "$seed" add f1; git -C "$seed" commit -qm squashed
git -C "$seed" push -q origin main
git -C "$r" fetch -q origin
out="$(cleanup_worktrees "$r" main)"
assert_contains "$out" "removed|" "reported removed"
git -C "$r" show-ref --verify --quiet refs/heads/topic && s=present || s=gone
assert_eq "gone" "$s" "squashed branch deleted"
teardown_test

setup_test "cleanup_worktrees keeps dirty and unmerged worktrees when pruning"
load_script
PRUNE_WORKTREES=1; DRY_RUN=0
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" dirty topicd
echo edit > "$r/.claude/worktrees/dirty/file"
add_worktree "$r" unmerged topicu
w="$r/.claude/worktrees/unmerged"
printf 'x\n' > "$w/only-here"; git -C "$w" add only-here; git -C "$w" commit -qm unlanded
out="$(cleanup_worktrees "$r" main)"
assert_contains "$out" "kept|$r/.claude/worktrees/dirty|dirty" "dirty kept"
assert_contains "$out" "kept|$r/.claude/worktrees/unmerged|unmerged" "unmerged kept"
[ -d "$r/.claude/worktrees/dirty" ] && s=present || s=gone
assert_eq "present" "$s" "dirty dir intact"
assert_eq "edit" "$(cat "$r/.claude/worktrees/dirty/file")" "dirty content intact"
[ -d "$r/.claude/worktrees/unmerged" ] && s=present || s=gone
assert_eq "present" "$s" "unmerged dir intact"
teardown_test

setup_test "cleanup_worktrees changes nothing under --dry-run"
load_script
PRUNE_WORKTREES=1; DRY_RUN=1
make_remote alpha; clone_repo alpha
r="$TMPDIR_ROOT/ws/alpha"
add_worktree "$r" wt1 topic
out="$(cleanup_worktrees "$r" main)"
assert_contains "$out" "removable|" "listed only"
[ -d "$r/.claude/worktrees/wt1" ] && s=present || s=gone
assert_eq "present" "$s" "dry run left it alone"
teardown_test

setup_test "end to end: syncs, skips dirty, lists removable worktrees"
load_script
make_remote alpha; clone_repo alpha
make_remote beta dev; clone_repo beta
seed="$TMPDIR_ROOT/seed-alpha"
echo more > "$seed/file"; git -C "$seed" commit -qam more; git -C "$seed" push -q origin main
a="$TMPDIR_ROOT/ws/alpha"; b="$TMPDIR_ROOT/ws/beta"
git -C "$a" switch -q -c feature
add_worktree "$b" wt1 topic
echo uncommitted > "$b/file"
out="$(bash "$SCRIPT" --root "$TMPDIR_ROOT/ws" 2>&1)"
assert_contains "$out" "alpha" "alpha reported"
assert_contains "$out" "beta" "beta reported"
assert_contains "$out" "dirty" "beta flagged dirty"
assert_contains "$out" "worktree removable" "removable worktree surfaced"
assert_eq "main" "$(git -C "$a" symbolic-ref --short HEAD)" "alpha moved to main"
assert_eq "more" "$(cat "$a/file")" "alpha fast-forwarded"
assert_eq "uncommitted" "$(cat "$b/file")" "beta untouched"
[ -d "$b/.claude/worktrees/wt1" ] && s=present || s=gone
assert_eq "present" "$s" "worktree not removed without the flag"
teardown_test

setup_test "end to end: --prune-worktrees removes the landed worktree"
load_script
make_remote alpha; clone_repo alpha
a="$TMPDIR_ROOT/ws/alpha"
add_worktree "$a" wt1 topic
out="$(bash "$SCRIPT" --root "$TMPDIR_ROOT/ws" --prune-worktrees 2>&1)"
assert_contains "$out" "worktree removed" "removal reported"
[ -d "$a/.claude/worktrees/wt1" ] && s=present || s=gone
assert_eq "gone" "$s" "worktree removed"
teardown_test

setup_test "end to end: --dry-run changes nothing"
load_script
make_remote alpha; clone_repo alpha
a="$TMPDIR_ROOT/ws/alpha"
git -C "$a" switch -q -c feature
add_worktree "$a" wt1 topic
bash "$SCRIPT" --root "$TMPDIR_ROOT/ws" --prune-worktrees --dry-run >/dev/null 2>&1
assert_eq "feature" "$(git -C "$a" symbolic-ref --short HEAD)" "branch unchanged"
[ -d "$a/.claude/worktrees/wt1" ] && s=present || s=gone
assert_eq "present" "$s" "worktree untouched"
teardown_test

setup_test "end to end: repo filter limits the sweep"
load_script
make_remote alpha; clone_repo alpha
make_remote beta;  clone_repo beta
a="$TMPDIR_ROOT/ws/alpha"; b="$TMPDIR_ROOT/ws/beta"
git -C "$a" switch -q -c feature
git -C "$b" switch -q -c feature
bash "$SCRIPT" --root "$TMPDIR_ROOT/ws" alpha >/dev/null 2>&1
assert_eq "main" "$(git -C "$a" symbolic-ref --short HEAD)" "alpha synced"
assert_eq "feature" "$(git -C "$b" symbolic-ref --short HEAD)" "beta skipped by filter"
teardown_test

setup_test "--help exits cleanly and --jobs validates"
load_script
bash "$SCRIPT" --help >/dev/null 2>&1 && rc=0 || rc=$?
assert_eq "0" "$rc" "help exit code"
bash "$SCRIPT" --jobs abc >/dev/null 2>&1 && rc=0 || rc=$?
assert_eq "2" "$rc" "bad --jobs rejected"
teardown_test

summary
