#!/usr/bin/env zsh
# Zsh configuration - Optimized for development
# Modular structure for better maintainability

# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

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
ZSH_THEME="powerlevel10k/powerlevel10k"

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

# Load Powerlevel10k configuration
if [[ -f "${ZDOTDIR:-$HOME}/.p10k.zsh" ]]; then
    source "${ZDOTDIR:-$HOME}/.p10k.zsh"
fi

# Show startup time after first prompt (only if instant prompt is not active)
if [[ -o interactive ]] && [[ -n "$ZSHRC_START_TIME" ]] && command -v bc &> /dev/null; then
    # Skip startup time display when Powerlevel10k instant prompt is active
    if [[ "${POWERLEVEL9K_INSTANT_PROMPT-}" != "off" ]] && [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
        # Instant prompt is active, skip the startup time display to avoid console output
        :
    else
        _show_startup_time_once() {
            local end_time=$(date +%s.%N 2>/dev/null || echo "0")
            local duration=$(echo "$end_time - $ZSHRC_START_TIME" | bc 2>/dev/null || echo "0")
            if (( $(echo "$duration > 0.1" | bc -l 2>/dev/null || echo 0) )); then
                echo "⚡ Zsh loaded in ${duration}s"
            fi
            # Remove this function after first run
            unfunction _show_startup_time_once
            precmd_functions=(${precmd_functions:#_show_startup_time_once})
        }
        # Add to precmd hooks to run after first prompt
        precmd_functions+=(_show_startup_time_once)
    fi
fi

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi

# Update commands
alias update='~/.local/bin/update'
alias update-quick='~/.local/bin/update-quick'
alias upd='update-quick'
alias upf='update'

# Update command aliases
if [ -f "$HOME/.update_aliases" ]; then
    source "$HOME/.update_aliases"
fi

# Update commands
alias update='~/.local/bin/update'
alias update-quick='~/.local/bin/update-quick'
alias upd='update-quick'
alias upf='update'
export PATH=$PATH:/usr/local/go/bin

# pnpm
export PNPM_HOME="/home/anto/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
# pnpm end
