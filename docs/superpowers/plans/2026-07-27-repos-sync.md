# repos-sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `repos-sync`, a command that brings every git repo under `~/Repos` up to date on its default branch without touching dirty ones, and removes worktrees whose branch has already landed.

**Architecture:** A single bash script, `scripts/repos-sync.sh`, structured as small pure-ish functions that each print a token so they can be unit-tested by sourcing the script. Phase 1 fetches all repos in parallel; phase 2 walks repos sequentially doing sync then worktree cleanup. A slash command and zsh aliases wrap it. Tests build throwaway bare remotes, clones and worktrees under `mktemp -d`.

**Tech Stack:** bash 5, git 2.x, the existing `scripts/tests/lib.sh` harness. No other dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-repos-sync-design.md`. Every behaviour below comes from it.
- Never destroy uncommitted, unpushed, or unlanded work. Anything not provably safe is kept and reported.
- `set -uo pipefail`, but **not** `set -e` — one bad repo must not abort the sweep.
- Script must be sourceable for testing: `main "$@"` runs only when `REPOS_SYNC_SOURCE_ONLY` is unset.
- Default root is `${REPOS_ROOT:-$HOME/Repos}`.
- Worktree removal uses `git worktree remove` with no `--force`, ever.
- All git invocations use `git -C <dir>`; the script never `cd`s.
- Colour output only when stdout is a TTY.
- Follow the file's existing sibling conventions: `#!/usr/bin/env bash`, a comment header explaining the contract, lowercase function names with `_` separators.

---

### Task 1: Script skeleton, CLI parsing, repo discovery

**Files:**
- Create: `scripts/repos-sync.sh`
- Create: `scripts/tests/test-repos-sync.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: globals `ROOT` (string), `JOBS` (int), `PRUNE_WORKTREES` (0/1), `DRY_RUN` (0/1), `FILTERS` (array); functions `usage()`, `parse_args()`, `discover_repos()` (prints one absolute repo path per line), `is_dirty DIR` (exit 0 when dirty).

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/test-repos-sync.sh`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: FAIL — `repos-sync.sh` does not exist, so sourcing errors out.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/repos-sync.sh`:

```bash
#!/usr/bin/env bash
# repos-sync — bring every git repo under a workspace root onto its default
# branch, and remove worktrees whose branch has already landed.
#
# Repos with uncommitted changes are never touched. Worktrees are only removed
# when they are clean AND their branch is provably already in the default
# branch. See docs/superpowers/specs/2026-07-27-repos-sync-design.md.
#
# Sourceable for tests: set REPOS_SYNC_SOURCE_ONLY=1 to skip main.

set -uo pipefail

ROOT="${REPOS_ROOT:-$HOME/Repos}"
JOBS=8
PRUNE_WORKTREES=0
DRY_RUN=0
FILTERS=()

if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'
    C_YELLOW=$'\033[1;33m'; C_BLUE=$'\033[0;34m'; C_CYAN=$'\033[0;36m'
else
    C_RESET=''; C_BOLD=''; C_DIM=''
    C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

usage() {
    cat <<'EOF'
Usage: repos-sync [options] [repo...]

Fetches every git repo under the workspace root, switches it to its default
branch and fast-forwards it. Repos with uncommitted changes are left alone.
Worktrees whose branch has already landed are reported, and removed with
--prune-worktrees.

Options:
  --prune-worktrees   Remove removable worktrees (default: only list them)
  --dry-run           Report what would happen; change nothing
  --jobs N            Parallel fetches (default: 8)
  --root DIR          Workspace root (default: $REPOS_ROOT or ~/Repos)
  -h, --help          Show this help

Positional arguments limit the run to the named repos.
EOF
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --prune-worktrees) PRUNE_WORKTREES=1 ;;
            --dry-run)         DRY_RUN=1 ;;
            --jobs)            JOBS="${2:?--jobs needs a number}"; shift ;;
            --jobs=*)          JOBS="${1#*=}" ;;
            --root)            ROOT="${2:?--root needs a directory}"; shift ;;
            --root=*)          ROOT="${1#*=}" ;;
            -h|--help)         usage; exit 0 ;;
            -*)                printf 'unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
            *)                 FILTERS+=("$1") ;;
        esac
        shift
    done
    case "$JOBS" in
        ''|*[!0-9]*) printf '--jobs must be a positive integer\n' >&2; exit 2 ;;
        0)           printf '--jobs must be at least 1\n' >&2; exit 2 ;;
    esac
    ROOT="${ROOT%/}"
}

in_filters() {
    local name="$1" f
    for f in ${FILTERS[@]+"${FILTERS[@]}"}; do
        [ "$f" = "$name" ] && return 0
    done
    return 1
}

discover_repos() {
    local d name
    for d in "$ROOT"/*/; do
        d="${d%/}"
        [ -e "$d/.git" ] || continue
        name="${d##*/}"
        if [ "${#FILTERS[@]}" -gt 0 ] && ! in_filters "$name"; then
            continue
        fi
        printf '%s\n' "$d"
    done
}

is_dirty() {
    [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]
}

main() {
    parse_args "$@"
    if [ ! -d "$ROOT" ]; then
        printf '%sroot not found: %s%s\n' "$C_RED" "$ROOT" "$C_RESET" >&2
        exit 1
    fi
    discover_repos
}

if [ -z "${REPOS_SYNC_SOURCE_ONLY:-}" ]; then
    main "$@"
fi
```

Then `chmod +x scripts/repos-sync.sh scripts/tests/test-repos-sync.sh`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 7  FAIL: 0`

- [ ] **Step 5: Commit**

```bash
git add scripts/repos-sync.sh scripts/tests/test-repos-sync.sh
git commit -m "feat(repos-sync): script skeleton, CLI parsing and repo discovery"
```

---

### Task 2: Default branch resolution

**Files:**
- Modify: `scripts/repos-sync.sh`
- Modify: `scripts/tests/test-repos-sync.sh`

**Interfaces:**
- Consumes: `is_dirty`.
- Produces: `has_origin REPO` (exit 0 when an `origin` remote exists); `default_branch REPO` (prints the short default branch name, e.g. `main`/`dev`/`master`, empty when undeterminable; repairs a missing `origin/HEAD` via `git remote set-head origin --auto`).

- [ ] **Step 1: Write the failing test**

Insert before `summary` in `scripts/tests/test-repos-sync.sh`:

```bash
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
make_repo "$TMPDIR_ROOT/ws/solo"
has_origin "$TMPDIR_ROOT/ws/solo" && s=yes || s=no
assert_eq "no" "$s" "no origin"
assert_eq "" "$(default_branch "$TMPDIR_ROOT/ws/solo")" "no default branch"
teardown_test
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: FAIL with `default_branch: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/repos-sync.sh` after `is_dirty`:

```bash
has_origin() {
    git -C "$1" remote get-url origin >/dev/null 2>&1
}

# Print the repo's default branch (short name), or nothing if undeterminable.
# Repairs a missing origin/HEAD, which some clones never had set.
default_branch() {
    local repo="$1" ref
    has_origin "$repo" || return 0
    ref=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
    if [ -z "$ref" ]; then
        git -C "$repo" remote set-head origin --auto >/dev/null 2>&1
        ref=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
    fi
    printf '%s' "${ref#origin/}"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 14  FAIL: 0`

- [ ] **Step 5: Commit**

```bash
git add scripts/repos-sync.sh scripts/tests/test-repos-sync.sh
git commit -m "feat(repos-sync): resolve and repair the default branch"
```

---

### Task 3: Sync a single repo

**Files:**
- Modify: `scripts/repos-sync.sh`
- Modify: `scripts/tests/test-repos-sync.sh`

**Interfaces:**
- Consumes: `is_dirty`, `has_origin`, `default_branch`.
- Produces: `worktree_holding_branch REPO BRANCH` (prints the worktree path that has BRANCH checked out, else nothing); `sync_repo REPO DEFAULT` printing exactly one line `STATUS|detail` where STATUS is one of `no-remote`, `no-default`, `dirty`, `locked`, `no-upstream`, `switched`, `current`, `updated`, `diverged`, `error`.

- [ ] **Step 1: Write the failing test**

Insert before `summary`:

```bash
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
make_repo "$TMPDIR_ROOT/ws/solo"
assert_eq "no-remote" "$(status_of "$(sync_repo "$TMPDIR_ROOT/ws/solo" "")")" "no remote"
teardown_test
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: FAIL with `sync_repo: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/repos-sync.sh` after `default_branch`:

```bash
# Print the worktree path that currently has BRANCH checked out, if any.
worktree_holding_branch() {
    git -C "$1" worktree list --porcelain 2>/dev/null | awk -v want="refs/heads/$2" '
        /^worktree /{ p = substr($0, 10) }
        /^branch /  { if (substr($0, 8) == want) { print p; exit } }
    '
}

# Bring one repo onto its default branch. Prints "STATUS|detail".
sync_repo() {
    local repo="$1" def="$2" cur holder before after
    has_origin "$repo" || { printf 'no-remote|no origin remote\n'; return; }
    [ -n "$def" ] || { printf 'no-default|cannot determine default branch\n'; return; }

    if is_dirty "$repo"; then
        printf 'dirty|%s uncommitted change(s)\n' \
            "$(git -C "$repo" status --porcelain | wc -l | tr -d ' ')"
        return
    fi
    if ! git -C "$repo" rev-parse --verify --quiet "refs/remotes/origin/$def" >/dev/null; then
        printf 'no-upstream|origin/%s does not exist\n' "$def"
        return
    fi

    holder="$(worktree_holding_branch "$repo" "$def")"
    if [ -n "$holder" ] && [ "$holder" != "$repo" ]; then
        printf 'locked|%s is checked out in %s\n' "$def" "${holder##*/}"
        return
    fi

    cur="$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null)"
    if [ "$cur" != "$def" ]; then
        if git -C "$repo" show-ref --verify --quiet "refs/heads/$def"; then
            git -C "$repo" switch --quiet "$def" 2>/dev/null \
                || { printf 'error|could not switch to %s\n' "$def"; return; }
        else
            git -C "$repo" switch --quiet --create "$def" --track "origin/$def" 2>/dev/null \
                || { printf 'error|could not create %s from origin\n' "$def"; return; }
        fi
    fi

    before="$(git -C "$repo" rev-parse --short HEAD)"
    if git -C "$repo" merge --ff-only --quiet "origin/$def" 2>/dev/null; then
        after="$(git -C "$repo" rev-parse --short HEAD)"
        if [ "$before" != "$after" ]; then
            printf 'updated|%s %s..%s\n' "$def" "$before" "$after"
        elif [ -n "$cur" ] && [ "$cur" != "$def" ]; then
            printf 'switched|%s -> %s\n' "$cur" "$def"
        elif [ -z "$cur" ]; then
            printf 'switched|detached -> %s\n' "$def"
        else
            printf 'current|%s\n' "$def"
        fi
    else
        printf 'diverged|%s has local commits not on origin/%s\n' "$def" "$def"
    fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 29  FAIL: 0`

- [ ] **Step 5: Commit**

```bash
git add scripts/repos-sync.sh scripts/tests/test-repos-sync.sh
git commit -m "feat(repos-sync): sync a repo to its default branch, skipping dirty ones"
```

---

### Task 4: Worktree listing and safety classification

**Files:**
- Modify: `scripts/repos-sync.sh`
- Modify: `scripts/tests/test-repos-sync.sh`

**Interfaces:**
- Consumes: `is_dirty`.
- Produces: `list_worktrees REPO` (prints `path<TAB>refs/heads/branch` per non-main worktree, branch empty when detached); `worktree_removable REPO BRANCH DEFAULT` (exit 0 and print reason `merged`/`squashed`/`upstream-gone`, else exit 1); `classify_worktree REPO PATH BRANCHREF DEFAULT` (prints `remove|reason` or `keep|reason`).

- [ ] **Step 1: Write the failing test**

Insert before `summary`:

```bash
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
assert_not_contains "$out" "$r	" "main tree excluded"
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: FAIL with `list_worktrees: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/repos-sync.sh` after `sync_repo`:

```bash
# Print "path<TAB>branchref" for every worktree except the main working tree.
# branchref is empty for a detached worktree.
list_worktrees() {
    git -C "$1" worktree list --porcelain 2>/dev/null | awk '
        /^worktree /{ if (p != "") print p "\t" b; p = substr($0, 10); b = "" }
        /^branch /  { b = substr($0, 8) }
        END         { if (p != "") print p "\t" b }
    ' | tail -n +2
}

# Exit 0 and print a reason when BRANCH is provably already in DEFAULT.
worktree_removable() {
    local repo="$1" branch="$2" def="$3" mb tree dangling upstream remote_ref

    # 1. Ordinary merge or rebase: every commit is already in the default branch.
    if git -C "$repo" merge-base --is-ancestor "$branch" "origin/$def" 2>/dev/null; then
        printf 'merged'
        return 0
    fi

    # 2. Squash merge: rebuild the branch's tree as one synthetic commit off the
    #    merge base and ask whether that patch is already applied. git cherry
    #    prefixes "-" when it is.
    mb="$(git -C "$repo" merge-base "origin/$def" "$branch" 2>/dev/null)"
    if [ -n "$mb" ]; then
        tree="$(git -C "$repo" rev-parse "$branch^{tree}" 2>/dev/null)"
        if [ -n "$tree" ]; then
            dangling="$(git -C "$repo" \
                -c user.name=repos-sync -c user.email=repos-sync@localhost \
                commit-tree "$tree" -p "$mb" -m _ 2>/dev/null)"
            if [ -n "$dangling" ] \
               && git -C "$repo" cherry "origin/$def" "$dangling" 2>/dev/null | grep -q '^-'; then
                printf 'squashed'
                return 0
            fi
        fi
    fi

    # 3. Upstream deleted on the remote and nothing lives only here.
    upstream="$(git -C "$repo" config --get "branch.$branch.merge" 2>/dev/null)"
    if [ -n "$upstream" ]; then
        remote_ref="refs/remotes/origin/${upstream#refs/heads/}"
        if ! git -C "$repo" show-ref --verify --quiet "$remote_ref" \
           && [ "$(git -C "$repo" rev-list --count "$branch" --not --remotes 2>/dev/null)" = "0" ]; then
            printf 'upstream-gone'
            return 0
        fi
    fi

    return 1
}

# Decide the fate of one worktree. Prints "remove|reason" or "keep|reason".
classify_worktree() {
    local repo="$1" path="$2" branchref="$3" def="$4" branch reason
    [ -d "$path" ]        || { printf 'keep|missing\n';  return; }
    [ -n "$branchref" ]   || { printf 'keep|detached\n'; return; }
    branch="${branchref#refs/heads/}"
    [ "$branch" != "$def" ] || { printf 'keep|default-branch\n'; return; }
    if is_dirty "$path"; then
        printf 'keep|dirty\n'
        return
    fi
    if reason="$(worktree_removable "$repo" "$branch" "$def")"; then
        printf 'remove|%s\n' "$reason"
    else
        printf 'keep|unmerged\n'
    fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 42  FAIL: 0`

- [ ] **Step 5: Commit**

```bash
git add scripts/repos-sync.sh scripts/tests/test-repos-sync.sh
git commit -m "feat(repos-sync): classify worktrees, detecting squash-merged branches"
```

---

### Task 5: Worktree cleanup with dry-run gating

**Files:**
- Modify: `scripts/repos-sync.sh`
- Modify: `scripts/tests/test-repos-sync.sh`

**Interfaces:**
- Consumes: `list_worktrees`, `classify_worktree`.
- Produces: `remove_worktree REPO PATH BRANCH REASON` (exit 0 on success); `cleanup_worktrees REPO DEFAULT` printing one line per worktree as `ACTION|path|reason` where ACTION is `removed`, `removable`, or `kept`, honouring `PRUNE_WORKTREES` and `DRY_RUN`.

- [ ] **Step 1: Write the failing test**

Insert before `summary`:

```bash
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: FAIL with `cleanup_worktrees: command not found`.

- [ ] **Step 3: Write minimal implementation**

Add to `scripts/repos-sync.sh` after `classify_worktree`:

```bash
# Remove one worktree and its now-orphaned branch. Never uses --force on the
# worktree, so git re-checks for modifications and aborts on its own if the
# state changed since classification.
remove_worktree() {
    local repo="$1" path="$2" branch="$3" reason="$4"
    git -C "$repo" worktree remove "$path" >/dev/null 2>&1 || return 1
    # -d refuses branches that are not ancestors, which is exactly the squashed
    # and upstream-gone cases we already proved safe.
    git -C "$repo" branch -d "$branch" >/dev/null 2>&1 && return 0
    case "$reason" in
        squashed|upstream-gone) git -C "$repo" branch -D "$branch" >/dev/null 2>&1 ;;
    esac
    return 0
}

# Walk a repo's worktrees. Prints "ACTION|path|reason" per worktree, where
# ACTION is removed, removable or kept.
cleanup_worktrees() {
    local repo="$1" def="$2" path branchref branch verdict action reason
    [ "$DRY_RUN" -eq 1 ] || git -C "$repo" worktree prune >/dev/null 2>&1
    while IFS=$'\t' read -r path branchref; do
        [ -n "$path" ] || continue
        verdict="$(classify_worktree "$repo" "$path" "$branchref" "$def")"
        action="${verdict%%|*}"
        reason="${verdict#*|}"
        if [ "$action" != "remove" ]; then
            printf 'kept|%s|%s\n' "$path" "$reason"
            continue
        fi
        if [ "$PRUNE_WORKTREES" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
            branch="${branchref#refs/heads/}"
            if remove_worktree "$repo" "$path" "$branch" "$reason"; then
                printf 'removed|%s|%s\n' "$path" "$reason"
            else
                printf 'kept|%s|remove-failed\n' "$path"
            fi
        else
            printf 'removable|%s|%s\n' "$path" "$reason"
        fi
    done < <(list_worktrees "$repo")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 58  FAIL: 0`

- [ ] **Step 5: Commit**

```bash
git add scripts/repos-sync.sh scripts/tests/test-repos-sync.sh
git commit -m "feat(repos-sync): remove landed worktrees behind --prune-worktrees"
```

---

### Task 6: Parallel fetch, reporting and summary

**Files:**
- Modify: `scripts/repos-sync.sh`
- Modify: `scripts/tests/test-repos-sync.sh`

**Interfaces:**
- Consumes: everything above.
- Produces: `fetch_all REPO...` (parallel `git fetch --all --prune --prune-tags`, capped at `JOBS`); `report_repo NAME STATUS DETAIL`; a `main` that runs the whole sweep and prints a summary line.

- [ ] **Step 1: Write the failing test**

Insert before `summary`:

```bash
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

setup_test "--help exits cleanly and --jobs validates"
load_script
bash "$SCRIPT" --help >/dev/null 2>&1 && rc=0 || rc=$?
assert_eq "0" "$rc" "help exit code"
bash "$SCRIPT" --jobs abc >/dev/null 2>&1 && rc=0 || rc=$?
assert_eq "2" "$rc" "bad --jobs rejected"
teardown_test
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: FAIL — the end-to-end runs print only repo paths, so the assertions on `dirty` / `worktree removable` fail.

- [ ] **Step 3: Write minimal implementation**

Add `fetch_all` and `report_repo` after `cleanup_worktrees`, and replace `main` entirely:

```bash
# Fetch every repo, at most JOBS at a time. Pruning here is what makes deleted
# upstream branches detectable during worktree classification.
fetch_all() {
    local repo running=0
    for repo in "$@"; do
        git -C "$repo" fetch --all --prune --prune-tags --quiet >/dev/null 2>&1 &
        running=$((running + 1))
        if [ "$running" -ge "$JOBS" ]; then
            wait -n 2>/dev/null || wait
            running=$((running - 1))
        fi
    done
    wait
}

report_repo() {
    local name="$1" status="$2" detail="$3" colour
    case "$status" in
        updated)            colour="$C_GREEN" ;;
        switched)           colour="$C_CYAN" ;;
        current)            colour="$C_DIM" ;;
        dirty|locked)       colour="$C_YELLOW" ;;
        diverged|error)     colour="$C_RED" ;;
        *)                  colour="$C_BLUE" ;;
    esac
    printf '%s%-34s%s %s%-10s%s %s%s%s\n' \
        "$C_BOLD" "$name" "$C_RESET" \
        "$colour" "$status" "$C_RESET" \
        "$C_DIM" "$detail" "$C_RESET"
}

main() {
    parse_args "$@"
    if [ ! -d "$ROOT" ]; then
        printf '%sroot not found: %s%s\n' "$C_RED" "$ROOT" "$C_RESET" >&2
        exit 1
    fi

    local repos=() repo name def line status detail
    while IFS= read -r repo; do
        [ -n "$repo" ] && repos+=("$repo")
    done < <(discover_repos)

    if [ "${#repos[@]}" -eq 0 ]; then
        printf 'no git repos found under %s\n' "$ROOT" >&2
        exit 1
    fi

    printf '%sfetching %d repos under %s%s\n\n' \
        "$C_DIM" "${#repos[@]}" "$ROOT" "$C_RESET"
    [ "$DRY_RUN" -eq 1 ] || fetch_all "${repos[@]}"

    local n_updated=0 n_current=0 n_switched=0 n_dirty=0 n_problem=0
    local n_removable=0 n_removed=0 n_kept=0
    local action path reason

    for repo in "${repos[@]}"; do
        name="${repo##*/}"
        def="$(default_branch "$repo")"
        line="$(sync_repo "$repo" "$def")"
        status="${line%%|*}"
        detail="${line#*|}"
        report_repo "$name" "$status" "$detail"
        case "$status" in
            updated)  n_updated=$((n_updated + 1)) ;;
            switched) n_switched=$((n_switched + 1)) ;;
            current)  n_current=$((n_current + 1)) ;;
            dirty)    n_dirty=$((n_dirty + 1)) ;;
            *)        n_problem=$((n_problem + 1)) ;;
        esac

        [ -n "$def" ] || continue
        while IFS='|' read -r action path reason; do
            [ -n "$action" ] || continue
            case "$action" in
                removed)
                    n_removed=$((n_removed + 1))
                    printf '    %s- worktree removed%s %s %s(%s)%s\n' \
                        "$C_GREEN" "$C_RESET" "${path##*/}" "$C_DIM" "$reason" "$C_RESET" ;;
                removable)
                    n_removable=$((n_removable + 1))
                    printf '    %s- worktree removable%s %s %s(%s)%s\n' \
                        "$C_YELLOW" "$C_RESET" "${path##*/}" "$C_DIM" "$reason" "$C_RESET" ;;
                kept)
                    n_kept=$((n_kept + 1)) ;;
            esac
        done < <(cleanup_worktrees "$repo" "$def")
    done

    printf '\n%s%d updated · %d switched · %d up to date · %d skipped (dirty) · %d other%s\n' \
        "$C_BOLD" "$n_updated" "$n_switched" "$n_current" "$n_dirty" "$n_problem" "$C_RESET"
    if [ "$n_removed" -gt 0 ]; then
        printf '%s%d worktrees removed · %d kept%s\n' \
            "$C_BOLD" "$n_removed" "$n_kept" "$C_RESET"
    elif [ "$n_removable" -gt 0 ]; then
        printf '%s%d worktrees removable · %d kept%s  %srerun with --prune-worktrees to remove them%s\n' \
            "$C_BOLD" "$n_removable" "$n_kept" "$C_RESET" "$C_DIM" "$C_RESET"
    else
        printf '%s%d worktrees kept, none removable%s\n' "$C_BOLD" "$n_kept" "$C_RESET"
    fi
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 74  FAIL: 0`

Then verify against the real workspace without changing anything:
Run: `bash scripts/repos-sync.sh --dry-run`
Expected: every repo reported, dirty ones flagged, removable worktrees listed, nothing modified.

- [ ] **Step 5: Commit**

```bash
git add scripts/repos-sync.sh scripts/tests/test-repos-sync.sh
git commit -m "feat(repos-sync): parallel fetch, per-repo reporting and summary"
```

---

### Task 7: Aliases, slash command and shellcheck

**Files:**
- Modify: `shell/aliases.zsh` (append near the existing `UPDATE_SCRIPT` block, around line 175)
- Create: `.claude/commands/repos-sync.md`

**Interfaces:**
- Consumes: `scripts/repos-sync.sh`.
- Produces: `repos-sync` and `rs` shell aliases; a `/repos-sync` slash command.

- [ ] **Step 1: Add the aliases**

Append to `shell/aliases.zsh` after the `update-manager` block:

```zsh
# Repo workspace sync
REPOS_SYNC_SCRIPT="$DOTFILES_DIR/scripts/repos-sync.sh"
if [[ -x "$REPOS_SYNC_SCRIPT" ]]; then
    alias repos-sync="$REPOS_SYNC_SCRIPT"
    alias rs="$REPOS_SYNC_SCRIPT"
fi
```

- [ ] **Step 2: Verify the aliases load**

Run: `zsh -ic 'alias repos-sync; alias rs'`
Expected: both aliases print, pointing at `scripts/repos-sync.sh`.

- [ ] **Step 3: Create the slash command**

Create `.claude/commands/repos-sync.md`:

```markdown
---
description: Sync every repo under ~/Repos to its default branch and clean up landed worktrees
---

Run `~/dotfiles/scripts/repos-sync.sh $ARGUMENTS` and report the result.

The script does all the git work. Do not reimplement any of its logic, and do
not run git commands to "fix up" repos it reported as skipped — being skipped
is the safe outcome, not a failure.

After it finishes:

1. Summarize: how many repos were updated, switched, already current, and
   skipped as dirty.
2. Call out anything in a `diverged`, `error`, `locked`, `no-remote` or
   `no-upstream` state, since those need a human decision.
3. If it reported removable worktrees and `--prune-worktrees` was not passed,
   list them and ask whether to rerun with `--prune-worktrees`. Do not pass
   that flag on your own initiative.
```

- [ ] **Step 4: Run shellcheck and the full test suite**

Run: `shellcheck scripts/repos-sync.sh scripts/tests/test-repos-sync.sh`
Expected: clean, or only warnings that the existing scripts also carry.

Run: `bash scripts/tests/test-repos-sync.sh`
Expected: `PASS: 74  FAIL: 0`

- [ ] **Step 5: Commit**

```bash
git add shell/aliases.zsh .claude/commands/repos-sync.md scripts/repos-sync.sh
git commit -m "feat(repos-sync): add shell aliases and /repos-sync slash command"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Deliverables table | 1 (script, tests), 7 (alias, slash command) |
| CLI flags | 1 (parse_args), 5 (`--prune-worktrees`, `--dry-run`), 6 (`--jobs`) |
| Repo discovery | 1 |
| Sync steps 1–2 (origin/HEAD repair) | 2 |
| Sync steps 3–6 (dirty, locked, switch, ff-only) | 3 |
| `git worktree prune` in every mode | 5 |
| Keep predicates (dirty, detached, default branch) | 4 |
| Remove predicates 1–3 | 4 |
| Removal without `--force`, `-d` then `-D` | 5 |
| Output and summary | 6 |
| Slash command | 7 |
| All eleven test cases | 3, 4, 5, 6 |

**Placeholder scan:** none — every step carries the code it needs.

**Type consistency:** `sync_repo` emits `STATUS|detail`; `main` splits on the
first `|`. `classify_worktree` emits `remove|reason` / `keep|reason`;
`cleanup_worktrees` splits the same way and re-emits `ACTION|path|reason`,
which `main` reads with `IFS='|'`. `worktree_removable` reasons (`merged`,
`squashed`, `upstream-gone`) are the same strings `remove_worktree` matches on
for the `-D` fallback. `list_worktrees` emits tab-separated `path<TAB>branchref`,
matching the `IFS=$'\t' read -r path branchref` consumers in tasks 4 and 5.
