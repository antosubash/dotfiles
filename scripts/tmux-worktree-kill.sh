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

# If git can't recognize the path as a worktree, infer the main repo from the
# `<main>/.worktrees/<name>[/sub...]` convention used by tmux-worktree-window.
# Echoes "<main_top> <worktree_path>" if the path matches and <main_top> is a
# git repo; non-zero otherwise.
orphan_worktree_paths() {
    p="$1"
    case "$p" in
        */.worktrees/*) ;;
        *) return 1 ;;
    esac
    main="${p%/.worktrees/*}"
    rest="${p#"$main"/.worktrees/}"
    name="${rest%%/*}"
    [ -n "$main" ] && [ -n "$name" ] || return 1
    git -C "$main" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
    printf '%s %s\n' "$main" "$main/.worktrees/$name"
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
        # Worktree might still exist as an orphan dir whose .git metadata was
        # pruned. Detect via the `.worktrees/<name>` convention.
        if orphan=$(orphan_worktree_paths "$pane_path"); then
            main_top=${orphan%% *}
            toplevel=${orphan#* }
        else
            tmux confirm-before -p "kill-window #${window_id}? (y/n)" "kill-window -t '$window_id'"
            return 0
        fi
    fi

    script_dir=$(cd "$(dirname "$0")" && pwd)
    script_abs="$script_dir/${0##*/}"

    q_main=$(sq_escape "$main_top")
    q_top=$(sq_escape "$toplevel")
    q_win=$(sq_escape "$window_id")
    inner="$script_abs remove '$q_main' '$q_top' '$q_win'"
    quoted_inner=$(sq_escape "$inner")

    tmux confirm-before -p "force-remove worktree $toplevel and kill window? (y/n)" "run-shell '$quoted_inner'"
}

cmd_remove() {
    main_top="${1:-}"
    worktree_path="${2:-}"
    window_id="${3:-}"

    # Try git first. If the worktree is registered, this also cleans up the
    # metadata under .git/worktrees/<name>. For an orphan dir whose metadata
    # was already pruned, git refuses with "not a working tree"; we then fall
    # back to nuking the directory directly.
    err=$(git -C "$main_top" worktree remove --force "$worktree_path" 2>&1)
    if [ -e "$worktree_path" ]; then
        if ! rm_err=$(rm -rf -- "$worktree_path" 2>&1); then
            tmux display-message "worktree remove failed: ${err:-$rm_err}"
            return 0
        fi
        # In case the registry still has a stale entry pointing at the now-gone dir.
        git -C "$main_top" worktree prune >/dev/null 2>&1 || true
    fi
    tmux kill-window -t "$window_id"
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
