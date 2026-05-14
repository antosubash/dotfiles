#!/bin/sh
# tmux-worktree-window: open a new tmux window in a git worktree.
# Subcommands:
#   prompt <pane_current_path>   - prompt for branch, then dispatch to spawn
#   spawn  <pane_current_path> <branch>  - resolve/create worktree, open window

# When sourced with _TMUX_WORKTREE_SOURCE_ONLY=1, only define functions.

main_toplevel() {
    path="$1"
    common_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
    # common_dir points at "<main>/.git". Its parent is the main toplevel.
    dirname "$common_dir"
}

sanitize_name() {
    name="$1"
    name=$(printf '%s' "$name" | sed 's/[^A-Za-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-$//')
    printf '%s' "$name"
}

ensure_worktree() {
    repo_path="$1"
    branch="$2"
    worktree_path="$3"

    if [ -d "$worktree_path" ]; then
        return 0
    fi

    if git -C "$repo_path" show-ref --verify --quiet "refs/heads/$branch"; then
        git -C "$repo_path" worktree add "$worktree_path" "$branch" >/dev/null
    elif git -C "$repo_path" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        git -C "$repo_path" worktree add -b "$branch" "$worktree_path" "origin/$branch" >/dev/null
    else
        git -C "$repo_path" worktree add -b "$branch" "$worktree_path" >/dev/null
    fi
}

cmd_prompt() {
    :  # placeholder, filled in later
}

cmd_spawn() {
    :  # placeholder, filled in later
}

main() {
    sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        prompt) cmd_prompt "$@" ;;
        spawn)  cmd_spawn  "$@" ;;
        *)
            printf 'tmux-worktree-window: unknown subcommand: %s\n' "$sub" >&2
            return 1
            ;;
    esac
}

if [ -z "${_TMUX_WORKTREE_SOURCE_ONLY:-}" ]; then
    main "$@"
fi
