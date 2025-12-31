# Shell profile
# This file is loaded by login shells

# Load local environment
if [ -f "$HOME/.local/bin/env" ]; then
    . "$HOME/.local/bin/env"
fi

# Set PATH
export PATH="$HOME/.local/bin:$PATH"

# Default shell
export SHELL=/bin/zsh

# Load zsh if available and we're running in zsh
if [ -n "$ZSH_VERSION" ] && [ -f "$HOME/.zshrc" ]; then
    source "$HOME/.zshrc"
fi