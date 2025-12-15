#!/bin/bash

# Dotfiles installation script
set -e

DOTFILES_DIR="$HOME/dotfiles"
BACKUP_DIR="$HOME/.dotfiles_backup"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Function to backup and symlink
backup_and_symlink() {
    local src="$1"
    local dest="$2"
    local dest_dir=$(dirname "$dest")
    
    if [ -f "$dest" ] || [ -d "$dest" ]; then
        echo "Backing up $dest to $BACKUP_DIR"
        mv "$dest" "$BACKUP_DIR/"
    fi
    
    mkdir -p "$dest_dir"
    echo "Creating symlink: $dest -> $src"
    ln -sf "$src" "$dest"
}

# Install configuration files
echo "Installing dotfiles..."

# Git configuration
backup_and_symlink "$DOTFILES_DIR/git/.gitconfig" "$HOME/.gitconfig"

# Shell configuration
backup_and_symlink "$DOTFILES_DIR/shell/.zshrc" "$HOME/.zshrc"
backup_and_symlink "$DOTFILES_DIR/shell/.profile" "$HOME/.profile"

# Vim configuration
backup_and_symlink "$DOTFILES_DIR/vim/.vimrc" "$HOME/.vimrc"

# Create directories for vim
mkdir -p "$HOME/.vim/autoload" "$HOME/.vim/bundle"

echo "Dotfiles installation complete!"
echo "Restart your shell or run 'source ~/.zshrc' to apply changes."