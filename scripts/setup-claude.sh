#!/bin/bash

# Setup Claude Code environment
# Symlinks settings, agents, and commands from dotfiles into ~/.claude/
set -e

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="$HOME/.claude"
BACKUP_DIR="$HOME/.dotfiles_backup"

echo "Setting up Claude Code environment..."

mkdir -p "$CLAUDE_DIR" "$BACKUP_DIR"

backup_and_symlink() {
    local src="$1"
    local dest="$2"
    local dest_dir
    dest_dir=$(dirname "$dest")

    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "Backing up $dest to $BACKUP_DIR/"
        mv "$dest" "$BACKUP_DIR/"
    elif [ -L "$dest" ]; then
        rm "$dest"
    fi

    mkdir -p "$dest_dir"
    echo "Creating symlink: $dest -> $src"
    ln -sf "$src" "$dest"
}

# Settings
backup_and_symlink "$DOTFILES_DIR/.claude/settings.json" "$CLAUDE_DIR/settings.json"

# Agents
backup_and_symlink "$DOTFILES_DIR/.claude/agents" "$CLAUDE_DIR/agents"

# Commands
backup_and_symlink "$DOTFILES_DIR/.claude/commands" "$CLAUDE_DIR/commands"

# Status line + session usage report
backup_and_symlink "$DOTFILES_DIR/.claude/statusline.py" "$CLAUDE_DIR/statusline.py"
backup_and_symlink "$DOTFILES_DIR/.claude/cc-sessions.py" "$CLAUDE_DIR/cc-sessions.py"

echo ""
echo "Claude Code setup complete!"
echo "  Settings:  ~/.claude/settings.json"
echo "  Agents:    ~/.claude/agents/"
echo "  Commands:  ~/.claude/commands/"
echo "  Statusline: ~/.claude/statusline.py"
echo "  Sessions:  ~/.claude/cc-sessions.py"
