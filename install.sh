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

# Neovim configuration
NVIM_CONFIG_DIR="$HOME/.config/nvim"
backup_and_symlink "$DOTFILES_DIR/nvim/init.lua" "$NVIM_CONFIG_DIR/init.lua"

# Powerlevel10k configuration
if [ -f "$DOTFILES_DIR/config/.p10k.zsh" ]; then
    backup_and_symlink "$DOTFILES_DIR/config/.p10k.zsh" "$HOME/.p10k.zsh"
    echo "Powerlevel10k configuration installed"
fi

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
        
        # Install Powerlevel10k theme
        if [ ! -d "$ZSH_CUSTOM/themes/powerlevel10k" ]; then
            echo "Installing Powerlevel10k theme..."
            git clone --depth=1 https://github.com/romkatv/powerlevel10k.git "$ZSH_CUSTOM/themes/powerlevel10k"
            echo "Powerlevel10k installed"
        else
            echo "Powerlevel10k already installed"
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

echo ""
echo "Running setup scripts..."
echo ""

# Run setup-update.sh (fail gracefully)
if [ -f "$DOTFILES_DIR/scripts/setup-update.sh" ]; then
    echo "Setting up update commands..."
    set +e
    bash "$DOTFILES_DIR/scripts/setup-update.sh"
    UPDATE_EXIT_CODE=$?
    set -e
    if [ $UPDATE_EXIT_CODE -ne 0 ]; then
        echo "Warning: setup-update.sh encountered errors but continuing installation..."
    fi
else
    echo "Warning: setup-update.sh not found"
fi

# Run setup-terminal.sh (fail gracefully)
if [ -f "$DOTFILES_DIR/scripts/setup-terminal.sh" ]; then
    echo ""
    echo "Setting up terminal..."
    set +e
    bash "$DOTFILES_DIR/scripts/setup-terminal.sh"
    TERMINAL_EXIT_CODE=$?
    set -e
    if [ $TERMINAL_EXIT_CODE -ne 0 ]; then
        echo "Warning: setup-terminal.sh encountered errors but continuing installation..."
    fi
else
    echo "Warning: setup-terminal.sh not found"
fi

echo ""
echo "Dotfiles installation complete!"
echo ""
echo "Next steps:"
if [ "$SHELL_TYPE" = "zsh" ]; then
    echo "  1. Apply Catppuccin Mocha colors from config/terminal-colors.md (if not using Alacritty)"
    echo "  2. Restart your shell or run 'source ~/.zshrc'"
    echo "  3. Run 'p10k configure' to customize your prompt (optional)"
else
    echo "  1. Restart your shell or run 'source ~/.bashrc' to apply changes"
    echo "  2. Consider switching to Zsh for enhanced features"
fi