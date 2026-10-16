# Bash configuration (derived from zshrc)

# Custom aliases
alias ll="ls -la"
alias la="ls -A"
alias l="ls -CF"
alias ..="cd .."
alias ...="cd ../.."
alias ....="cd ../../.."
alias grep="grep --color=auto"
alias fgrep="fgrep --color=auto"
alias egrep="egrep --color=auto"

# Development aliases
alias gs="git status"
alias ga="git add"
alias gc="git commit"
alias gp="git push"
alias gl="git pull"
alias gd="git diff"

# Node.js
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# Python
export PATH="$HOME/.local/bin:$PATH"

# Go
export GOPATH="$HOME/go"
export PATH="$GOPATH/bin:$PATH"

# Local bin
export PATH="$HOME/.local/bin:$PATH"

# Load local environment
if [ -f "$HOME/.local/bin/env" ]; then
    . "$HOME/.local/bin/env"
fi

# Bash-specific settings
if [ -f ~/.bash_completion ]; then
    . ~/.bash_completion
fi

# Enable bash completion if available
if [ -f /etc/bash_completion ] && ! shopt -oq posix; then
    . /etc/bash_completion
fi

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi

# Rust / cargo
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

# .NET
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools"

# Go toolchain
export PATH="$PATH:/usr/local/go/bin"

# pnpm
export PNPM_HOME="$HOME/.local/share/pnpm"
for d in "$PNPM_HOME/bin" "$PNPM_HOME"; do
  case ":$PATH:" in
    *":$d:"*) ;;
    *) PATH="$d:$PATH" ;;
  esac
done
export PATH
# pnpm end

# tmux aliases & helpers
if [ -f "$HOME/dotfiles/shell/tmux-aliases.sh" ]; then
    . "$HOME/dotfiles/shell/tmux-aliases.sh"
fi

# atuin — fuzzy, SQLite-backed shell history; rebinds Ctrl-R and Up-arrow.
# bash-preexec is required for atuin's bash hooks.
if command -v atuin > /dev/null 2>&1; then
    if [ ! -f "$HOME/.bash-preexec.sh" ]; then
        # Pinned to the 0.7.0 release commit and checked: this file is sourced
        # into every shell, so never take whatever master serves.
        _bp_tmp="$(mktemp)"
        if curl -fsSL https://raw.githubusercontent.com/rcaloras/bash-preexec/d866eeefdb8dfce075cbd4e37dc73c4deb4b0bd2/bash-preexec.sh \
                -o "$_bp_tmp" 2>/dev/null &&
            echo "33de4e70ee84981d46e7d8a0e3105f1dd9affc9c4178594446cd96e7ef3b2752  $_bp_tmp" | sha256sum -c --status; then
            mv "$_bp_tmp" "$HOME/.bash-preexec.sh"
        else
            rm -f "$_bp_tmp"
        fi
        unset _bp_tmp
    fi
    [ -f "$HOME/.bash-preexec.sh" ] && . "$HOME/.bash-preexec.sh"
    eval "$(atuin init bash)"
fi
