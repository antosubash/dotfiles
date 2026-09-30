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

    # Replace existing symlinks outright: moving them into the backup dir on a
    # re-run would overwrite the real backup of the original file.
    if [ -L "$dest" ]; then
        rm "$dest"
    elif [ -e "$dest" ]; then
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

# Link both regardless of the invoking shell: zsh becomes the login shell below,
# so bootstrapping from bash must still install .zshrc.
backup_and_symlink "$DOTFILES_DIR/shell/.zshrc" "$HOME/.zshrc"
backup_and_symlink "$DOTFILES_DIR/shell/.bashrc" "$HOME/.bashrc"
echo "Zsh and Bash configuration installed"

# Always install .profile for login shells
backup_and_symlink "$DOTFILES_DIR/shell/.profile" "$HOME/.profile"

# Vim configuration
backup_and_symlink "$DOTFILES_DIR/vim/.vimrc" "$HOME/.vimrc"

# tmux configuration
backup_and_symlink "$DOTFILES_DIR/tmux/.tmux.conf" "$HOME/.tmux.conf"

# Create directories for vim
mkdir -p "$HOME/.vim/autoload" "$HOME/.vim/bundle"

# Neovim configuration — symlink the whole directory so init.lua + lua/ are picked up.
NVIM_CONFIG_DIR="$HOME/.config/nvim"
backup_and_symlink "$DOTFILES_DIR/nvim" "$NVIM_CONFIG_DIR"

# Powerlevel10k configuration
if [ -f "$DOTFILES_DIR/config/.p10k.zsh" ]; then
    backup_and_symlink "$DOTFILES_DIR/config/.p10k.zsh" "$HOME/.p10k.zsh"
    echo "Powerlevel10k configuration installed"
fi

# Claude Code — settings, agents, and commands
if [ -f "$DOTFILES_DIR/scripts/setup-claude.sh" ]; then
    bash "$DOTFILES_DIR/scripts/setup-claude.sh"
fi

# Pi coding agent — settings, shared agents, workflows, skills, and extensions
if [ -f "$DOTFILES_DIR/scripts/setup-pi.sh" ]; then
    bash "$DOTFILES_DIR/scripts/setup-pi.sh"
fi

# Zsh and Oh My Zsh setup. Runs whenever zsh is installed, not only when this
# script was launched from zsh; shell/.zshrc already lists the plugins.
setup_zsh() {
    if command -v zsh > /dev/null 2>&1; then
        bash "$DOTFILES_DIR/scripts/setup-oh-my-zsh.sh"
    fi
}

# Make zsh the default login shell if it's installed.
# This runs regardless of the shell install.sh was invoked from, so users
# bootstrapping from bash also get switched over.
set_default_shell_zsh() {
    if ! command -v zsh > /dev/null 2>&1; then
        return 0
    fi
    local zsh_path
    zsh_path="$(command -v zsh)"

    # Make sure zsh is listed as a valid login shell.
    if ! grep -Fxq "$zsh_path" /etc/shells 2>/dev/null; then
        echo "$zsh_path" | sudo tee -a /etc/shells > /dev/null
    fi

    local current_shell
    current_shell="$(getent passwd "$USER" | awk -F: '{print $7}')"
    if [ "$current_shell" = "$zsh_path" ]; then
        echo "Default shell is already zsh ($zsh_path)."
    else
        echo "Changing default shell from $current_shell to $zsh_path..."
        sudo chsh -s "$zsh_path" "$USER" || \
            echo "Warning: chsh failed — run 'sudo chsh -s $zsh_path $USER' manually."
    fi
}

# Setup Zsh
setup_zsh

# Make zsh the default shell (works even when invoked from bash)
set_default_shell_zsh

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
if command -v zsh > /dev/null 2>&1; then
    echo "  1. Apply Catppuccin Mocha colors from config/terminal-colors.md (if not using Alacritty)"
    echo "  2. Log out and back in (zsh is now the login shell), or run 'exec zsh'"
    echo "  3. Run 'p10k configure' to customize your prompt (optional)"
else
    echo "  1. Restart your shell or run 'source ~/.bashrc' to apply changes"
    echo "  2. Install zsh (e.g. scripts/setup-ubuntu.sh), then re-run ./install.sh to switch to it"
fi