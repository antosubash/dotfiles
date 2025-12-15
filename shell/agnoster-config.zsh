# Enhanced Agnoster Theme Configuration
# Essential customizations for the enhanced agnoster theme

# Core Agnoster theme customizations
export DEFAULT_USER=$USERNAME  # Hide username in local sessions
export TERM="xterm-256color"   # Ensure 256-color support

# Enhanced Agnoster display options
export AGNOSTER_SHOW_USER=${AGNOSTER_SHOW_USER:-false}     # Hide username in local sessions
export AGNOSTER_SHOW_EXEC_TIME=${AGNOSTER_SHOW_EXEC_TIME:-true}  # Show command execution time

# Development environment detection
export VIRTUAL_ENV_DISABLE_PROMPT=${VIRTUAL_ENV_DISABLE_PROMPT:-0}  # Show virtualenv by default

# Modern tool aliases
if command -v eza &> /dev/null; then
    alias ls="eza --icons"
    alias ll="eza -la --git --icons"
    alias tree="eza --tree --icons"
fi

if command -v bat &> /dev/null; then
    alias cat="bat --style=numbers,changes,header"
fi

if command -v fd &> /dev/null; then
    alias find="fd"
fi

if command -v rg &> /dev/null; then
    alias grep="rg --smart-case"
fi

# Git aliases
if command -v git &> /dev/null; then
    alias gs="git status --short --branch"
    alias ga="git add"
    alias gc="git commit"
    alias gp="git push"
    alias gl="git pull"
    alias gd="git diff --color-moved=zebra"
fi

# Custom configuration loading
if [[ -f $HOME/.zshrc.local ]]; then
    source $HOME/.zshrc.local
fi