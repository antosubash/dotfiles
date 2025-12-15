#!/usr/bin/env zsh
# Performance monitoring and optimizations

# Track startup time (set in main .zshrc)
# This file is loaded after constants, so ZSHRC_START_TIME should already be set

# Function to display startup time
show_startup_time() {
    if [[ -n "$ZSHRC_START_TIME" ]] && command -v bc &> /dev/null; then
        local end_time=$(date +%s.%N 2>/dev/null || echo "0")
        local duration=$(echo "$end_time - $ZSHRC_START_TIME" | bc 2>/dev/null || echo "0")
        if (( $(echo "$duration > 0.1" | bc -l 2>/dev/null || echo 0) )); then
            echo "⚡ Zsh loaded in ${duration}s"
        fi
    fi
}

# Lazy load heavy commands (for future use)
lazy_load_command() {
    local command_name="$1"
    local load_command="$2"
    
    # Create a function that loads the command on first use
    eval "${command_name}() {
        unfunction ${command_name}
        ${load_command}
        ${command_name} \"\$@\"
    }"
}

# Optimize Oh My Zsh loading (already set in constants, but ensure they're exported)
export DISABLE_UPDATE_PROMPT="${DISABLE_UPDATE_PROMPT:-true}"
export COMPLETION_WAITING_DOTS="${COMPLETION_WAITING_DOTS:-true}"
export DISABLE_UNTRACKED_FILES_DIRTY="${DISABLE_UNTRACKED_FILES_DIRTY:-true}"

# Create cache directory for completion
if [[ -z "$CACHE_DIR" ]]; then
    export CACHE_DIR="$HOME/.cache/zsh"
fi
mkdir -p "$CACHE_DIR" 2>/dev/null

