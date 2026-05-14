#!/bin/sh
# tmux-worktree-window: open a new tmux window in a git worktree.
# Subcommands:
#   prompt <pane_current_path>   - prompt for branch, then dispatch to spawn
#   spawn  <pane_current_path> <branch>  - resolve/create worktree, open window

# When sourced with _TMUX_WORKTREE_SOURCE_ONLY=1, only define functions.

sanitize_name() {
    name="$1"
    name=$(printf '%s' "$name" | sed 's/[^A-Za-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-$//')
    printf '%s' "$name"
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
