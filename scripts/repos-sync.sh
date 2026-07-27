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
        ''|*[!0-9]*) printf -- '--jobs must be a positive integer\n' >&2; exit 2 ;;
        0)           printf -- '--jobs must be at least 1\n' >&2; exit 2 ;;
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
