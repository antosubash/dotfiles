# tmux quick-start aliases & helpers
# Sourced by both .bashrc and .zshrc

# Attach to 'main' session, creating it if missing.
alias tm='tmux new-session -A -s main'
alias tma='tmux attach'
alias tml='tmux ls'
alias tmk='tmux kill-session -t'

# Open/attach a named session: `ts foo` -> session 'foo'
ts() {
    local name="${1:-main}"
    tmux new-session -A -s "$name"
}

# Pre-built layout for parallel Claude Code work:
#   - shell  : git/commands
#   - claude : primary Claude session
#   - claude2: secondary Claude session
# Usage: claude-session [session-name]
claude-session() {
    local name="${1:-claude}"
    if tmux has-session -t "$name" 2>/dev/null; then
        tmux attach -t "$name"
        return
    fi
    tmux new-session  -d -s "$name" -n shell
    tmux new-window   -t "$name"    -n claude
    tmux new-window   -t "$name"    -n claude2
    tmux select-window -t "$name":claude
    tmux attach -t "$name"
}

# Opt-in SSH auto-attach: export TMUX_AUTO_ATTACH=1 in your profile
# to be dropped into 'main' tmux session on SSH login.
if [ -n "$SSH_CONNECTION" ] && [ -z "$TMUX" ] && [ "$TMUX_AUTO_ATTACH" = "1" ] && command -v tmux >/dev/null 2>&1; then
    exec tmux new-session -A -s main
fi
