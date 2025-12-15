#!/bin/bash

# Dotfiles installation script (cross-platform)
set -e

# Get the directory where this script is located
DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

# Zsh and Oh My Zsh setup
setup_zsh() {
    if [ "$SHELL_TYPE" = "zsh" ]; then
        # Install Oh My Zsh if not installed
        if [ ! -d "$HOME/.oh-my-zsh" ]; then
            echo "Installing Oh My Zsh..."
            RUNZSH=no sh -c "$(curl -fsSL https://raw.github.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
        else
            echo "Oh My Zsh is already installed"
        fi
        
        # Install zsh plugins
        ZSH_CUSTOM="$HOME/.oh-my-zsh/custom"
        
        # Install zsh-autosuggestions
        if [ ! -d "$ZSH_CUSTOM/plugins/zsh-autosuggestions" ]; then
            echo "Installing zsh-autosuggestions..."
            git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH_CUSTOM/plugins/zsh-autosuggestions"
        fi
        
        # Install zsh-syntax-highlighting
        if [ ! -d "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting" ]; then
            echo "Installing zsh-syntax-highlighting..."
            git clone https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM/plugins/zsh-syntax-highlighting"
        fi
        
        # Ensure plugins are properly configured in .zshrc
        if [ -f "$HOME/.zshrc" ]; then
            # Update plugins list to include autosuggestions and syntax highlighting
            sed -i '' 's/plugins=(git)/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' "$HOME/.zshrc" || true
            echo "Zsh plugins configured"
        fi
        
        # Configure shell to use zsh if not already
        if [ "$SHELL" != "$(which zsh)" ]; then
            echo "Changing default shell to zsh..."
            chsh -s $(which zsh)
        fi
    fi
}

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

# Setup Zsh
setup_zsh

echo "Dotfiles installation complete!"
if [ "$SHELL_TYPE" = "zsh" ]; then
    echo "Restart your shell or run 'source ~/.zshrc' to apply changes."
else
    echo "Restart your shell or run 'source ~/.bashrc' to apply changes."
fi