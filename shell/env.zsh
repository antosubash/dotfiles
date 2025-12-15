#!/usr/bin/env zsh
# Environment variables configuration

# Source constants (already loaded in main .zshrc, but ensure it's available)
if [[ -z "$DOTFILES_DIR" ]]; then
    export DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
fi

# Editor
export EDITOR="$EDITOR"
export VISUAL="$VISUAL"

# Locale
export LANG="$LANG"
export LC_ALL="$LC_ALL"

# Terminal
export TERM="$TERM"

# History
export HISTFILE="$HISTORY_FILE"
export HISTSIZE="$HISTSIZE"
export SAVEHIST="$SAVEHIST"

# Development paths
export PATH="$LOCAL_BIN_DIR:$HOME/.cargo/bin:$PATH"
export GOPATH="$GOPATH"
export PATH="$GOPATH/bin:$PATH"

# Node.js (NVM)
export NVM_DIR="$NVM_DIR"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

# pnpm
export PNPM_HOME="$PNPM_HOME"
export PATH="$PNPM_HOME:$PATH"

# Python
export PYTHONPATH="$HOME/.local/lib/python3.*/site-packages"
export PIP_CACHE_DIR="$PIP_CACHE_DIR"

# .NET
export DOTNET_ROOT="$DOTNET_ROOT"
export PATH="$PATH:$DOTNET_ROOT:$DOTNET_ROOT/tools"

# Go
export GO111MODULE=on
export GOPROXY="https://proxy.golang.org,direct"

# Java (if installed)
if [[ "$OSTYPE" == "darwin"* ]]; then
    export JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || echo "")
fi

# Rust (if installed)
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

