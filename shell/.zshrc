#!/usr/bin/env zsh
# Zsh configuration - Optimized for development
# Modular structure for better maintainability

# Track startup time for performance monitoring
export ZSHRC_START_TIME=$(date +%s.%N 2>/dev/null || echo "0")

# Determine dotfiles directory
if [[ -z "$DOTFILES_DIR" ]]; then
    if [[ -d "$HOME/dotfiles" ]]; then
        export DOTFILES_DIR="$HOME/dotfiles"
    elif [[ -d "${0:A:h}/.." ]]; then
        export DOTFILES_DIR="${0:A:h}/.."
    else
        export DOTFILES_DIR="$HOME/dotfiles"
    fi
fi

# Source constants first
if [[ -f "$DOTFILES_DIR/shell/constants.zsh" ]]; then
    source "$DOTFILES_DIR/shell/constants.zsh"
elif [[ -f "$HOME/dotfiles/shell/constants.zsh" ]]; then
    source "$HOME/dotfiles/shell/constants.zsh"
fi

# Load zsh options (must be early for performance)
if [[ -f "$DOTFILES_DIR/shell/options.zsh" ]]; then
    source "$DOTFILES_DIR/shell/options.zsh"
else
    # Fallback: set basic options if module not found
    setopt AUTO_CD CORRECT INTERACTIVE_COMMENTS
    setopt INC_APPEND_HISTORY HIST_IGNORE_ALL_DUPS SHARE_HISTORY
fi

# Load environment variables
if [[ -f "$DOTFILES_DIR/shell/env.zsh" ]]; then
    source "$DOTFILES_DIR/shell/env.zsh"
fi

# Oh My Zsh configuration
export ZSH="${ZSH_DIR:-$HOME/.oh-my-zsh}"
ZSH_THEME="${ZSH_THEME:-agnoster}"
plugins=(
    git
    zsh-autosuggestions
    zsh-syntax-highlighting
    docker
    docker-compose
    kubectl
    npm
    node
    python
    pip
    vscode
)

# Oh My Zsh optimizations
DISABLE_UPDATE_PROMPT="${DISABLE_UPDATE_PROMPT:-true}"
COMPLETION_WAITING_DOTS="${COMPLETION_WAITING_DOTS:-true}"
DISABLE_UNTRACKED_FILES_DIRTY="${DISABLE_UNTRACKED_FILES_DIRTY:-true}"

# Load Oh My Zsh
if [[ -d "$ZSH" ]]; then
    source "$ZSH/oh-my-zsh.sh"
fi

# Load aliases
if [[ -f "$DOTFILES_DIR/shell/aliases.zsh" ]]; then
    source "$DOTFILES_DIR/shell/aliases.zsh"
fi

# Load functions
if [[ -f "$DOTFILES_DIR/shell/functions.zsh" ]]; then
    source "$DOTFILES_DIR/shell/functions.zsh"
fi

# Load completion configuration
if [[ -f "$DOTFILES_DIR/shell/completion.zsh" ]]; then
    source "$DOTFILES_DIR/shell/completion.zsh"
fi

# Load performance optimizations
if [[ -f "$DOTFILES_DIR/shell/performance.zsh" ]]; then
    source "$DOTFILES_DIR/shell/performance.zsh"
fi

# Load local overrides if they exist
if [[ -f "${ZSHRC_LOCAL:-$HOME/.zshrc.local}" ]]; then
    source "${ZSHRC_LOCAL:-$HOME/.zshrc.local}"
fi

# Load local environment
if [[ -f "${ENV_FILE:-$HOME/.local/bin/env}" ]]; then
    source "${ENV_FILE:-$HOME/.local/bin/env}"
fi

# Show startup time if significant (only in interactive shells)
if [[ -o interactive ]] && [[ -n "$ZSHRC_START_TIME" ]] && command -v bc &> /dev/null; then
    local end_time=$(date +%s.%N 2>/dev/null || echo "0")
    local duration=$(echo "$end_time - $ZSHRC_START_TIME" | bc 2>/dev/null || echo "0")
    if (( $(echo "$duration > 0.1" | bc -l 2>/dev/null || echo 0) )); then
        echo "⚡ Zsh loaded in ${duration}s"
    fi
fi
