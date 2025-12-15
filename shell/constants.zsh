#!/usr/bin/env zsh
# Constants for Zsh configuration
# All hardcoded strings should be defined here

# Paths (set DOTFILES_DIR if not already set)
if [[ -z "$DOTFILES_DIR" ]]; then
    if [[ -d "$HOME/dotfiles" ]]; then
        export DOTFILES_DIR="$HOME/dotfiles"
    else
        export DOTFILES_DIR="$HOME/dotfiles"
    fi
fi

export ZSH_DIR="${ZSH_DIR:-$HOME/.oh-my-zsh}"
export ZSH_CUSTOM_DIR="${ZSH_CUSTOM_DIR:-$ZSH_DIR/custom}"
export LOCAL_BIN_DIR="$HOME/.local/bin"
export CACHE_DIR="$HOME/.cache/zsh"
export HISTORY_FILE="$HOME/.zsh_history"

# History settings
export HISTSIZE=1000000
export SAVEHIST=1000000

# Oh My Zsh settings
export ZSH_THEME="agnoster"
export DISABLE_UPDATE_PROMPT=true
export COMPLETION_WAITING_DOTS=true
export DISABLE_UNTRACKED_FILES_DIRTY=true

# Editor
export EDITOR="vim"
export VISUAL="vim"

# Locale
export LANG="en_US.UTF-8"
export LC_ALL="en_US.UTF-8"

# Terminal
export TERM="xterm-256color"

# Development paths
export GOPATH="$HOME/go"
export DOTNET_ROOT="$HOME/.dotnet"
export NVM_DIR="$HOME/.nvm"
export PNPM_HOME="$HOME/.local/share/pnpm"
export PIP_CACHE_DIR="$HOME/.cache/pip"

# Tool names (for detection)
export TOOL_EXA="eza"
export TOOL_BAT="bat"
export TOOL_FD="fd"
export TOOL_RIPGREP="rg"
export TOOL_FZF="fzf"
export TOOL_HTOP="htop"
export TOOL_NEOFETCH="neofetch"
export TOOL_FORTUNE="fortune"
export TOOL_COWSAY="cowsay"

# Font names
export FONT_MESLO="Meslo LG Nerd Font"

# File paths
export ZSHRC_LOCAL="$HOME/.zshrc.local"
export UPDATE_ALIASES_FILE="$HOME/.update_aliases"
export ENV_FILE="$LOCAL_BIN_DIR/env"
export LAST_UPDATE_FILE="$HOME/.last_update"

# Update reminder threshold (days)
export UPDATE_REMINDER_DAYS=7

# Plugin names
export PLUGIN_AUTOSUGGESTIONS="zsh-autosuggestions"
export PLUGIN_SYNTAX_HIGHLIGHTING="zsh-syntax-highlighting"

# Messages
export MSG_ZSH_LOADED="Zsh loaded successfully!"
export MSG_UPDATE_REMINDER="⚠️  It's been over a week since your last full update. Run 'update' to update everything."

