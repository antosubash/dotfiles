#!/bin/sh
# tmux-worktree-kill: confirm-and-kill a tmux window, removing the underlying
# git worktree if the window's cwd is one created by tmux-worktree-window.sh.
#
# Subcommands:
#   prompt <pane_current_path> <window_id>
#       Detect whether the window sits inside a worktree under
#       <main>/.worktrees/<name>. If so, confirm removal of the worktree
#       and the window. Otherwise, do a plain kill-window confirmation.
#   remove <main_toplevel> <worktree_path> <window_id>
#       Run `git worktree remove` and kill the window on success. Errors
#       from git are shown via tmux display-message.
#
# When sourced with _TMUX_WORKTREE_SOURCE_ONLY=1, only define functions.

main_toplevel() {
    common_dir=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
    dirname "$common_dir"
}

# Quote a string for safe inclusion inside single quotes.
sq_escape() {
    printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

cmd_prompt() {
    pane_path="${1:-}"
    window_id="${2:-}"

    toplevel=$(git -C "$pane_path" rev-parse --show-toplevel 2>/dev/null)
    main_top=$(main_toplevel "$pane_path" 2>/dev/null)

    if [ -z "$toplevel" ] || [ -z "$main_top" ] || [ "$toplevel" = "$main_top" ]; then
        # Not in a worktree (no repo, or sitting in the main repo).
        # Mimic the default kill-window confirmation.
        tmux confirm-before -p "kill-window #${window_id}? (y/n)" "kill-window -t '$window_id'"
        return 0
    fi

    script_dir=$(cd "$(dirname "$0")" && pwd)
    script_abs="$script_dir/${0##*/}"

    q_main=$(sq_escape "$main_top")
    q_top=$(sq_escape "$toplevel")
    q_win=$(sq_escape "$window_id")
    inner="$script_abs remove '$q_main' '$q_top' '$q_win'"
    quoted_inner=$(sq_escape "$inner")

    tmux confirm-before -p "remove worktree $toplevel and kill window? (y/n)" "run-shell '$quoted_inner'"
}

cmd_remove() {
    main_top="${1:-}"
    worktree_path="${2:-}"
    window_id="${3:-}"

    if err=$(git -C "$main_top" worktree remove "$worktree_path" 2>&1); then
        tmux kill-window -t "$window_id"
    else
        tmux display-message "worktree remove failed: $err"
    fi
}

main() {
    sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        prompt) cmd_prompt "$@" ;;
        remove) cmd_remove  "$@" ;;
        *)
            printf 'tmux-worktree-kill: unknown subcommand: %s\n' "$sub" >&2
            return 1
            ;;
    esac
}

if [ -z "${_TMUX_WORKTREE_SOURCE_ONLY:-}" ]; then
    main "$@"
fi
