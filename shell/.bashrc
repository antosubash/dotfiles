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

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi
. "$HOME/.cargo/env"

# pnpm
export PNPM_HOME="/root/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME/bin:"*) ;;
  *) export PATH="$PNPM_HOME/bin:$PATH" ;;
esac
# pnpm end

# tmux aliases & helpers
if [ -f "$HOME/dotfiles/shell/tmux-aliases.sh" ]; then
    . "$HOME/dotfiles/shell/tmux-aliases.sh"
fi

# atuin — fuzzy, SQLite-backed shell history; rebinds Ctrl-R and Up-arrow.
# bash-preexec is required for atuin's bash hooks.
if command -v atuin > /dev/null 2>&1; then
    if [ ! -f "$HOME/.bash-preexec.sh" ]; then
        curl -sL https://raw.githubusercontent.com/rcaloras/bash-preexec/master/bash-preexec.sh \
            -o "$HOME/.bash-preexec.sh" 2>/dev/null
    fi
    [ -f "$HOME/.bash-preexec.sh" ] && . "$HOME/.bash-preexec.sh"
    eval "$(atuin init bash)"
fi
export DOTNET_ROOT=$HOME/.dotnet
export PATH=$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools
export PATH=$PATH:/usr/local/go/bin
source ~/.cargo/env
export PATH=$PATH:~/go/bin

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi
