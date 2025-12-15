#!/bin/bash

# Dotfiles installation script (cross-platform)
set -e

DOTFILES_DIR="$HOME/dotfiles"
BACKUP_DIR="$HOME/.dotfiles_backup"

# Detect OS
OS="$(uname -s)"
case "${OS}" in
    Darwin*)    OS_TYPE="macos";;
    Linux*)     OS_TYPE="linux";;
    *)          OS_TYPE="unknown";;
esac

echo "Detected OS: $OS_TYPE"

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

# Function to detect shell
detect_shell() {
    if [ -n "$ZSH_VERSION" ]; then
        echo "zsh"
    elif [ -n "$BASH_VERSION" ]; then
        echo "bash"
    else
        echo "unknown"
    fi
}

# Install configuration files
echo "Installing dotfiles..."

# Git configuration
backup_and_symlink "$DOTFILES_DIR/git/.gitconfig" "$HOME/.gitconfig"

# Shell configuration
SHELL_TYPE=$(detect_shell)
echo "Detected shell: $SHELL_TYPE"

if [ "$SHELL_TYPE" = "zsh" ]; then
    backup_and_symlink "$DOTFILES_DIR/shell/.zshrc" "$HOME/.zshrc"
    echo "Zsh configuration installed"
elif [ "$SHELL_TYPE" = "bash" ]; then
    backup_and_symlink "$DOTFILES_DIR/shell/.bashrc" "$HOME/.bashrc" 2>/dev/null || true
    echo "Bash configuration installed"
fi

# Always install .profile for login shells
backup_and_symlink "$DOTFILES_DIR/shell/.profile" "$HOME/.profile"

# Vim configuration
backup_and_symlink "$DOTFILES_DIR/vim/.vimrc" "$HOME/.vimrc"

# Create directories for vim
mkdir -p "$HOME/.vim/autoload" "$HOME/.vim/bundle"

# Platform-specific setup
if [ "$OS_TYPE" = "linux" ]; then
    echo "Linux-specific setup..."
    # Create .bashrc if it doesn't exist and we're on bash
    if [ "$SHELL_TYPE" = "bash" ] && [ ! -f "$HOME/.bashrc" ]; then
        echo "Creating .bashrc for bash shell"
        cp "$DOTFILES_DIR/shell/.zshrc" "$DOTFILES_DIR/shell/.bashrc"
        # Remove zsh-specific content
        sed -i '/ZSH/d; /oh-my-zsh/d; /plugins=/d' "$DOTFILES_DIR/shell/.bashrc"
        backup_and_symlink "$DOTFILES_DIR/shell/.bashrc" "$HOME/.bashrc"
    fi
fi

echo "Dotfiles installation complete!"
if [ "$SHELL_TYPE" = "zsh" ]; then
    echo "Restart your shell or run 'source ~/.zshrc' to apply changes."
else
    echo "Restart your shell or run 'source ~/.bashrc' to apply changes."
fi