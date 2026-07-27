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
