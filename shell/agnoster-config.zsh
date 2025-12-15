# Agnoster Theme Configuration
# Copy this section to your custom .zshrc.local if you want customizations

# Agnoster theme customizations
export DEFAULT_USER=$USERNAME  # Hide username in local sessions
export TERM="xterm-256color"  # Ensure 256-color support

# Customize Agnoster segments (uncomment to disable specific segments)
# export VIRTUAL_ENV_DISABLE_PROMPT=1  # Hide virtualenv
# export AWS_PROMPT_DISABLE=1          # Hide AWS profile

# Custom symbols for Agnoster
# export AGNOSTER_GIT_DIRTY_SYMBOL=" ✗"
# export AGNOSTER_GIT_CLEAN_SYMBOL=" ✓"
# export AGNOSTER_NODE_SYMBOL="⬢ "
# export AGNOSTER_RUST_SYMBOL="🦀 "
# export AGNOSTER_GO_SYMBOL="🐹 "
# export AGNOSTER_K8S_SYMBOL="☸️ "
# export AGNOSTER_DOCKER_SYMBOL="🐳 "
# export AGNOSTER_AWS_SYMBOL="☁️ "

# Aliases for better Agnoster experience
if command -v exa &> /dev/null; then
    alias ls="exa --icons"
    alias ll="exa --icons -lah"
    alias la="exa --icons -lah --git"
fi

if command -v bat &> /dev/null; then
    alias cat="bat --theme=GitHub"
fi

if command -v fd &> /dev/null; then
    alias find="fd"
fi

# Enhanced prompt for development environments
if [[ -f $HOME/.zshrc.local ]]; then
    source $HOME/.zshrc.local
fi