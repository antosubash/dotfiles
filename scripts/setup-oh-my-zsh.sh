#!/bin/bash

# Install Oh My Zsh plus the plugins and theme shell/.zshrc expects.
#
# Idempotent, never touches ~/.zshrc (it is the dotfiles symlink), and repairs
# a partial install where only ~/.oh-my-zsh/custom exists — which happens when
# plugins are cloned before Oh My Zsh itself and every "is ~/.oh-my-zsh a
# directory?" check then wrongly reports it as installed.
set -e

ZSH_DIR="$HOME/.oh-my-zsh"
ZSH_CUSTOM_DIR="$ZSH_DIR/custom"
OH_MY_ZSH_URL="https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh"

if [ -f "$ZSH_DIR/oh-my-zsh.sh" ]; then
    echo "Oh My Zsh is already installed."
else
    partial=""
    if [ -d "$ZSH_DIR" ]; then
        # The upstream installer refuses to run over an existing directory, so
        # park the partial install and merge its custom/ back afterwards.
        partial="$(mktemp -d)"
        mv "$ZSH_DIR" "$partial/oh-my-zsh"
    fi

    echo "Installing Oh My Zsh..."
    # KEEP_ZSHRC stops the installer replacing the ~/.zshrc symlink with its template.
    if ! RUNZSH=no CHSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL "$OH_MY_ZSH_URL")"; then
        if [ -n "$partial" ] && [ ! -e "$ZSH_DIR" ]; then
            mv "$partial/oh-my-zsh" "$ZSH_DIR"
            rm -rf "$partial"
        fi
        echo "Failed to install Oh My Zsh." >&2
        exit 1
    fi

    if [ -n "$partial" ]; then
        cp -R "$partial/oh-my-zsh/custom/." "$ZSH_CUSTOM_DIR/"
        rm -rf "$partial"
    fi
fi

clone_if_missing() {
    local url="$1"
    local dest="$2"
    if [ -d "$dest" ]; then
        echo "$(basename "$dest") is already installed."
    else
        echo "Installing $(basename "$dest")..."
        git clone --depth=1 "$url" "$dest"
    fi
}

clone_if_missing https://github.com/zsh-users/zsh-autosuggestions "$ZSH_CUSTOM_DIR/plugins/zsh-autosuggestions"
clone_if_missing https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM_DIR/plugins/zsh-syntax-highlighting"
clone_if_missing https://github.com/romkatv/powerlevel10k.git "$ZSH_CUSTOM_DIR/themes/powerlevel10k"
