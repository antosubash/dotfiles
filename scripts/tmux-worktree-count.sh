#!/bin/sh
# Print "wt:N " (trailing space) for the worktree count of the repo
# containing $1, when there is more than one worktree. Silent otherwise.
#
# Counts entries under <git-common-dir>/worktrees/ instead of parsing
# `git worktree list`, since rev-parse is much cheaper than listing every
# worktree's HEAD/branch on each 5s status refresh.

set -eu

dir="${1:-$PWD}"
common=$(git -C "$dir" rev-parse --git-common-dir 2>/dev/null) || exit 0
case "$common" in
    /*) ;;
    *)  common="$dir/$common" ;;
esac

n=1
if [ -d "$common/worktrees" ]; then
    for entry in "$common/worktrees"/*/; do
        [ -e "$entry" ] || break
        n=$((n + 1))
    done
fi

[ "$n" -gt 1 ] && printf 'wt:%d ' "$n"
