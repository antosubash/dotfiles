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

# Quote a string for safe inclusion inside single quotes.
# Replaces every ' with '\''  (close, escaped quote, reopen).
sq_escape() {
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

cmd_prompt() {
    pane_path="${1:-}"

    if ! git -C "$pane_path" rev-parse --git-dir >/dev/null 2>&1; then
        tmux display-message "not a git repo"
        return 0
    fi

    # Resolve this script's absolute path so the callback can locate it
    # regardless of cwd at the time the prompt is submitted.
    script_dir=$(cd "$(dirname "$0")" && pwd)
    script_abs="$script_dir/$(basename "$0")"

    # Build the run-shell command: script_abs spawn <pane_path> <%%>
    # pane_path is single-quoted (with embedded single quotes escaped).
    # %% is substituted by tmux as the user's branch input; we wrap it in
    # double quotes so spaces survive. Branch names are restricted by git
    # to a safe character set, so this is sufficient.
    quoted_path=$(sq_escape "$pane_path")
    inner="$script_abs spawn '$quoted_path' \"%%\""
    quoted_inner=$(sq_escape "$inner")

    tmux command-prompt -p "branch:" "run-shell '$quoted_inner'"
}

cmd_spawn() {
    pane_path="${1:-}"
    branch="${2:-}"

    if [ -z "$branch" ]; then
        return 0
    fi

    sanitized=$(sanitize_name "$branch")
    if [ -z "$sanitized" ]; then
        tmux display-message "invalid branch name"
        return 0
    fi

    toplevel=$(main_toplevel "$pane_path") || {
        tmux display-message "not a git repo"
        return 0
    }

    worktree_path="$toplevel/.worktrees/$sanitized"

    if ! err=$(ensure_worktree "$pane_path" "$branch" "$worktree_path" 2>&1); then
        tmux display-message "$err"
        return 0
    fi

    tmux new-window -n "$sanitized" -c "$worktree_path"
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
