#!/bin/sh
# tmux-worktree-window: open a new tmux window in a git worktree.
# Subcommands:
#   prompt    <pane_current_path>            - prompt for branch, then spawn
#   spawn     <pane_current_path> <branch>   - resolve/create worktree, open window
#   prompt-pr <pane_current_path>            - prompt for PR number, then spawn-pr
#   spawn-pr  <pane_current_path> <pr_num>   - resolve PR head ref, fetch into a
#                                              local branch, open worktree window

# When sourced with _TMUX_WORKTREE_SOURCE_ONLY=1, only define functions.

main_toplevel() {
    common_dir=$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
    # common_dir points at "<main>/.git". Its parent is the main toplevel.
    dirname "$common_dir"
}

sanitize_name() {
    printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/-/g; s/--*/-/g; s/^-//; s/-$//'
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

# Issue a tmux command-prompt that, on submit, dispatches to one of this
# script's subcommands with (pane_path, user_input). pane_path is captured
# at prompt time and baked into the callback so the spawn step knows which
# repo to target regardless of where the user moves before submitting.
issue_prompt() {
    pane_path="$1"
    label="$2"
    subcmd="$3"

    if ! main_toplevel "$pane_path" >/dev/null 2>&1; then
        tmux display-message "not a git repo"
        return 0
    fi

    script_dir=$(cd "$(dirname "$0")" && pwd)
    script_abs="$script_dir/${0##*/}"

    # pane_path is single-quoted (with embedded quotes escaped). %% is
    # substituted by tmux with the user's input; we wrap it in double
    # quotes so spaces survive. Branch names / PR numbers are constrained
    # enough that this is sufficient.
    quoted_path=$(sq_escape "$pane_path")
    inner="$script_abs $subcmd '$quoted_path' \"%%\""
    quoted_inner=$(sq_escape "$inner")

    tmux command-prompt -p "$label" "run-shell '$quoted_inner'"
}

cmd_prompt() {
    issue_prompt "${1:-}" "branch:" "spawn"
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

    if ! err=$(ensure_worktree "$toplevel" "$branch" "$worktree_path" 2>&1); then
        tmux display-message "$err"
        return 0
    fi

    tmux new-window -n "$sanitized" -c "$worktree_path"
}

# Resolve a PR's head ref name via gh. Echoes the ref on success; non-zero on
# failure (PR not found, gh not authenticated, not a github remote, etc.).
gh_pr_head_ref() {
    pr_num="$1"
    repo_path="$2"
    (cd "$repo_path" && gh pr view "$pr_num" --json headRefName --jq .headRefName 2>&1)
}

# Fetch the PR head into a new local branch, then create the worktree.
ensure_pr_worktree() {
    repo_path="$1"
    pr_num="$2"
    branch="$3"
    worktree_path="$4"

    if [ -d "$worktree_path" ]; then
        return 0
    fi

    if ! git -C "$repo_path" show-ref --verify --quiet "refs/heads/$branch"; then
        git -C "$repo_path" fetch origin "refs/pull/$pr_num/head:refs/heads/$branch" >/dev/null
    fi

    git -C "$repo_path" worktree add "$worktree_path" "$branch" >/dev/null
}

cmd_prompt_pr() {
    issue_prompt "${1:-}" "PR #:" "spawn-pr"
}

cmd_spawn_pr() {
    pane_path="${1:-}"
    pr_num="${2:-}"

    if [ -z "$pr_num" ]; then
        return 0
    fi

    case "$pr_num" in
        *[!0-9]*)
            tmux display-message "invalid PR number: $pr_num"
            return 0
            ;;
    esac

    toplevel=$(main_toplevel "$pane_path") || {
        tmux display-message "not a git repo"
        return 0
    }

    if ! head_ref=$(gh_pr_head_ref "$pr_num" "$toplevel"); then
        tmux display-message "gh pr view #$pr_num failed: $head_ref"
        return 0
    fi
    if [ -z "$head_ref" ]; then
        tmux display-message "gh pr view #$pr_num returned no head ref"
        return 0
    fi

    sanitized_head=$(sanitize_name "$head_ref")
    [ -z "$sanitized_head" ] && sanitized_head="head"
    branch="pr-${pr_num}-${sanitized_head}"
    worktree_path="$toplevel/.worktrees/$branch"

    if ! err=$(ensure_pr_worktree "$toplevel" "$pr_num" "$branch" "$worktree_path" 2>&1); then
        tmux display-message "$err"
        return 0
    fi

    tmux new-window -n "$branch" -c "$worktree_path"
}

main() {
    sub="${1:-}"
    [ $# -gt 0 ] && shift
    case "$sub" in
        prompt)    cmd_prompt    "$@" ;;
        spawn)     cmd_spawn     "$@" ;;
        prompt-pr) cmd_prompt_pr "$@" ;;
        spawn-pr)  cmd_spawn_pr  "$@" ;;
        *)
            printf 'tmux-worktree-window: unknown subcommand: %s\n' "$sub" >&2
            return 1
            ;;
    esac
}

if [ -z "${_TMUX_WORKTREE_SOURCE_ONLY:-}" ]; then
    main "$@"
fi
