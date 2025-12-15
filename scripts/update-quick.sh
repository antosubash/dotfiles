#!/bin/bash

# Quick Update Script - Fast updates for daily use
# Runs only essential updates for quick daily maintenance

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() {
    echo -e "${GREEN}✓${NC} $1"
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo "🚀 Quick Update - Daily Maintenance"

# Detect OS
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="macos"
else
    OS="linux"
fi

# Update package manager
if [[ "$OS" == "macos" ]]; then
    if command -v brew &> /dev/null; then
        info "Updating Homebrew..."
        brew update
        log "Homebrew updated"
        
        info "Upgrading packages (quick)..."
        brew upgrade --quiet
        log "Packages upgraded"
    fi
else
    if command -v apt &> /dev/null; then
        info "Updating APT..."
        sudo apt update
        log "APT updated"
        
        info "Upgrading packages..."
        sudo apt upgrade -y
        log "Packages upgraded"
    fi
fi

# Update global npm packages (only if outdated)
if command -v npm &> /dev/null; then
    outdated=$(npm outdated -g --depth=0 2>/dev/null | wc -l)
    if [[ $outdated -gt 0 ]]; then
        info "Updating npm packages..."
        npm update -g --silent
        log "npm packages updated"
    fi
fi

# Update Rust (only if needed)
if command -v rustup &> /dev/null; then
    info "Checking Rust updates..."
    if rustup check | grep -q "Update available"; then
        rustup update
        log "Rust updated"
    else
        log "Rust is up to date"
    fi
fi

# Update dotfiles
if [[ -d "$HOME/dotfiles" ]]; then
    info "Updating dotfiles..."
    cd "$HOME/dotfiles"
    git pull origin main --quiet
    log "Dotfiles updated"
fi

# Quick cleanup
if [[ "$OS" == "macos" ]]; then
    if command -v brew &> /dev/null; then
        info "Quick cleanup..."
        brew cleanup --quiet --prune=3
        log "Cleanup completed"
    fi
fi

echo -e "\n${GREEN}✨ Quick update completed!${NC}"
warn "Run './scripts/update-all.sh' for full updates"