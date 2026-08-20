#!/bin/bash

# Set up Pi while keeping credentials, trust decisions, and sessions local.
set -e

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_DIR="$HOME/.pi/agent"
BACKUP_DIR="$HOME/.dotfiles_backup"

printf '%s\n' "Setting up Pi development workflow..."
mkdir -p "$PI_DIR" "$BACKUP_DIR"

backup_and_symlink() {
    local src="$1"
    local dest="$2"
    local label="$3"

    if [ -L "$dest" ]; then
        rm "$dest"
    elif [ -e "$dest" ]; then
        local backup="$BACKUP_DIR/${label}-$(date +%Y%m%d-%H%M%S)"
        printf 'Backing up %s to %s\n' "$dest" "$backup"
        mv "$dest" "$backup"
    fi

    mkdir -p "$(dirname "$dest")"
    printf 'Creating symlink: %s -> %s\n' "$dest" "$src"
    ln -s "$src" "$dest"
}

backup_and_symlink "$DOTFILES_DIR/pi/agent/settings.json" "$PI_DIR/settings.json" "pi-settings.json"
backup_and_symlink "$DOTFILES_DIR/pi/agent/prompts" "$PI_DIR/prompts" "pi-prompts"
backup_and_symlink "$DOTFILES_DIR/pi/agent/skills" "$PI_DIR/skills" "pi-skills"
backup_and_symlink "$DOTFILES_DIR/pi/agent/agents" "$PI_DIR/agents" "pi-agents"
backup_and_symlink "$DOTFILES_DIR/pi/agent/extensions" "$PI_DIR/extensions" "pi-extensions"

printf '%s\n' "Pi setup complete. Credentials, trust.json, and sessions remain under $PI_DIR."
printf '%s\n' "Run /reload in an existing Pi session or restart Pi to load the workflow."
