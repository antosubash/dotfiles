#!/usr/bin/env zsh
# Completion configuration

# Auto-completion enhancements
zstyle ':completion:*' menu select
zstyle ':completion:*' group-name ''
zstyle ':completion:*' completer _expand _complete _correct _approximate
zstyle ':completion:*' matcher-list '' 'm:{a-zA-Z}={A-Za-z}' 'r:|[._-]=* r:|=* l:|=*'
zstyle ':completion:*' special-dirs true
zstyle ':completion:*' list-colors ''

# Case insensitive completion
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Z}' 'm:{a-zA-Z}={A-Za-z}'

# Cache completion results
zstyle ':completion:*' use-cache yes
zstyle ':completion:*' cache-path "$HOME/.cache/zsh"

# Fuzzy completion with fzf if available
if [[ -z "$DOTFILES_DIR" ]]; then
    export DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
fi

if command -v "$TOOL_FZF" &> /dev/null; then
    # Use fzf for history search (Ctrl+R)
    export FZF_DEFAULT_COMMAND='rg --files --no-ignore --hidden --follow --glob "!.git/*"'
    export FZF_CTRL_T_COMMAND="$FZF_DEFAULT_COMMAND"
    export FZF_ALT_C_COMMAND='cd $(find * -type d | fzf) && cd -'
    
    # Integrate with zsh
    [ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
fi

