#!/bin/bash

# Terminal Setup Script with Powerlevel10k Theme
# Essential setup for modern terminal experience

set -e

# Constants
readonly DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
readonly ZSH_DIR="$HOME/.oh-my-zsh"
readonly ALACRITTY_CONFIG_DIR="$HOME/.config/alacritty"
readonly FONT_MESLO="MesloLGS NF"

# Colors for output
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly RED='\033[0;31m'
readonly NC='\033[0m'

print_status() {
    echo -e "${GREEN}✓${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Function to backup and symlink
backup_and_symlink() {
    local src="$1"
    local dest="$2"
    local dest_dir=$(dirname "$dest")
    local backup_dir="$HOME/.dotfiles_backup"
    
    mkdir -p "$backup_dir"
    mkdir -p "$dest_dir"
    
    # Replace existing symlinks outright: moving them into the backup dir on a
    # re-run would overwrite the real backup of the original file.
    if [ -L "$dest" ]; then
        rm "$dest"
    elif [ -e "$dest" ]; then
        print_info "Backing up $dest to $backup_dir"
        mv "$dest" "$backup_dir/" 2>/dev/null || true
    fi
    
    print_info "Creating symlink: $dest -> $src"
    ln -sf "$src" "$dest"
}

# Check dependencies
check_dependencies() {
    print_info "Checking dependencies..."
    
    if ! command -v zsh &> /dev/null; then
        print_warning "Zsh is not installed. Installing..."
        if [[ "$OSTYPE" == "darwin"* ]]; then
            if command -v brew &> /dev/null; then
                brew install zsh
            else
                print_error "Homebrew not found. Please install zsh manually."
                return 1
            fi
        else
            if command -v apt &> /dev/null; then
                sudo apt install -y zsh
            else
                print_error "Package manager not found. Please install zsh manually."
                return 1
            fi
        fi
        print_status "Zsh installed"
    else
        print_status "Zsh already installed"
    fi
    
    # Oh My Zsh, plugins, and Powerlevel10k (repairs a custom/-only partial install)
    if bash "$(dirname "${BASH_SOURCE[0]}")/setup-oh-my-zsh.sh"; then
        print_status "Oh My Zsh, plugins, and Powerlevel10k installed"
    else
        print_error "Failed to install Oh My Zsh"
        return 1
    fi
    
    print_status "Dependencies checked"
}

# Install required fonts for Powerlevel10k
install_fonts() {
    print_info "Installing fonts for Powerlevel10k theme..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            # Try to install font-meslo-lg-nerd-font (contains MesloLGS NF)
            if brew install --cask font-meslo-lg-nerd-font 2>/dev/null; then
                print_status "$FONT_MESLO installed via Homebrew"
            else
                print_warning "Failed to install $FONT_MESLO via Homebrew (may already be installed)"
            fi
        else
            print_warning "Homebrew not found. Please install $FONT_MESLO manually"
            print_info "You can download fonts from: https://github.com/romkatv/powerlevel10k#fonts"
        fi
    else
        # Linux font installation
        FONT_DIR="$HOME/.local/share/fonts"
        mkdir -p "$FONT_DIR"
        
        print_info "Downloading MesloLGS NF fonts for Linux..."
        local font_urls=(
            "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Regular.ttf"
            "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold.ttf"
            "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Italic.ttf"
            "https://github.com/romkatv/powerlevel10k-media/raw/master/MesloLGS%20NF%20Bold%20Italic.ttf"
        )
        
        for url in "${font_urls[@]}"; do
            local filename=$(basename "$url" | sed 's/%20/ /g')
            if [[ ! -f "$FONT_DIR/$filename" ]]; then
                if curl -fLo "$FONT_DIR/$filename" "$url" 2>/dev/null; then
                    print_status "Downloaded $filename"
                else
                    print_warning "Failed to download $filename"
                fi
            fi
        done
    fi
    
    if command -v fc-cache &> /dev/null; then
        print_info "Refreshing font cache..."
        fc-cache -fv 2>/dev/null || true
    fi
}

# Configure zsh
configure_zsh() {
    print_info "Configuring Zsh..."
    
    local zshrc_file="$HOME/.zshrc"
    local dotfiles_zshrc="$DOTFILES_DIR/shell/.zshrc"
    local p10k_config="$HOME/.p10k.zsh"
    local dotfiles_p10k="$DOTFILES_DIR/config/.p10k.zsh"
    
    # Create symlink for .zshrc
    if [[ -f "$dotfiles_zshrc" ]]; then
        backup_and_symlink "$dotfiles_zshrc" "$zshrc_file"
        print_status "Dotfiles .zshrc symlinked"
    fi
    
    # Create symlink for .p10k.zsh if it exists
    if [[ -f "$dotfiles_p10k" ]]; then
        backup_and_symlink "$dotfiles_p10k" "$p10k_config"
        print_status "Powerlevel10k config symlinked"
    else
        print_warning ".p10k.zsh config not found. You can run 'p10k configure' after setup."
    fi
}

# Install Alacritty terminal emulator
install_alacritty() {
    print_info "Installing Alacritty terminal emulator..."
    
    if command -v alacritty &> /dev/null; then
        print_status "Alacritty already installed"
        return 0
    fi
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            print_info "Installing Alacritty via Homebrew..."
            if brew install --cask alacritty 2>/dev/null; then
                print_status "Alacritty installed"
            else
                print_warning "Failed to install Alacritty (may already be installed)"
            fi
        else
            print_warning "Homebrew not found. Please install Alacritty manually"
            print_info "Visit: https://github.com/alacritty/alacritty"
        fi
    elif command -v apt &> /dev/null; then
        print_info "Installing Alacritty via apt..."
        if sudo apt install -y alacritty 2>/dev/null; then
            print_status "Alacritty installed"
        else
            print_warning "Failed to install Alacritty. Please install manually"
            print_info "Visit: https://github.com/alacritty/alacritty"
        fi
    else
        print_warning "Package manager not found. Please install Alacritty manually"
        print_info "Visit: https://github.com/alacritty/alacritty"
    fi
}

# Configure Alacritty
configure_alacritty() {
    print_info "Configuring Alacritty..."
    
    local alacritty_config="$ALACRITTY_CONFIG_DIR/alacritty.toml"
    local dotfiles_alacritty="$DOTFILES_DIR/config/alacritty.toml"
    
    # Create symlink for Alacritty config
    if [[ -f "$dotfiles_alacritty" ]]; then
        backup_and_symlink "$dotfiles_alacritty" "$alacritty_config"
        print_status "Alacritty config symlinked"
    else
        print_warning "Alacritty config not found in dotfiles"
        print_info "You can configure Alacritty manually at $alacritty_config"
    fi
}

# Make Alacritty the default terminal on Linux desktops (Ctrl+Alt+T, "Open in
# Terminal"): xdg-terminal-exec for GNOME 46+, x-terminal-emulator for the rest.
set_default_terminal() {
    if [[ "$OSTYPE" != "linux"* ]] || ! command -v alacritty &> /dev/null; then
        return 0
    fi
    print_info "Setting Alacritty as the default terminal..."

    local terminals_list="${XDG_CONFIG_HOME:-$HOME/.config}/xdg-terminals.list"
    if [[ "$(head -n 1 "$terminals_list" 2>/dev/null)" != "Alacritty.desktop" ]]; then
        mkdir -p "$(dirname "$terminals_list")"
        { echo "Alacritty.desktop"; grep -vx "Alacritty.desktop" "$terminals_list" 2>/dev/null || true; } > "$terminals_list.tmp"
        mv "$terminals_list.tmp" "$terminals_list"
    fi

    local alacritty_bin
    alacritty_bin="$(command -v alacritty)"
    if update-alternatives --list x-terminal-emulator 2>/dev/null | grep -qx "$alacritty_bin" &&
        [[ "$(readlink -f /etc/alternatives/x-terminal-emulator)" != "$alacritty_bin" ]]; then
        sudo update-alternatives --set x-terminal-emulator "$alacritty_bin"
    fi
    print_status "Alacritty is the default terminal"
}

# Install essential CLI tools
install_essential_tools() {
    print_info "Installing essential CLI tools..."
    
    if command -v brew &> /dev/null; then
        local tools=(
            "eza"
            "bat"
            "fd"
            "ripgrep"
        )
        
        for tool in "${tools[@]}"; do
            if ! command -v "$tool" &> /dev/null; then
                print_info "Installing $tool..."
                if brew install "$tool" 2>/dev/null; then
                    print_status "$tool installed"
                else
                    print_warning "Failed to install $tool"
                fi
            else
                print_status "$tool already installed"
            fi
        done
    elif command -v apt &> /dev/null; then
        print_info "For Linux, please install eza, bat, fd, and ripgrep using your package manager"
        print_info "Example: sudo apt install eza bat fd-find ripgrep"
    else
        print_warning "Package manager not found. Please install tools manually"
    fi
}

# Verify installation
verify_installation() {
    print_info "Verifying installation..."
    
    local errors=0
    
    if ! command -v zsh &> /dev/null; then
        print_error "Zsh is not installed"
        ((errors++))
    fi
    
    if [[ ! -f "$ZSH_DIR/oh-my-zsh.sh" ]]; then
        print_error "Oh My Zsh is not installed"
        ((errors++))
    fi
    
    if [[ ! -f "$HOME/.zshrc" ]]; then
        print_error ".zshrc file not found"
        ((errors++))
    fi
    
    if [[ $errors -eq 0 ]]; then
        print_status "Installation verified successfully"
        return 0
    else
        print_error "Installation verification failed with $errors error(s)"
        return 1
    fi
}

# Main installation
main() {
    echo "🎨 Setting up Terminal with Powerlevel10k Theme"
    echo "================================================"
    echo ""
    
    if ! check_dependencies; then
        print_error "Failed to install dependencies"
        exit 1
    fi
    
    install_fonts
    configure_zsh
    install_alacritty
    configure_alacritty
    set_default_terminal
    install_essential_tools
    
    echo ""
    if verify_installation; then
        print_status "✨ Terminal setup complete!"
        echo ""
        print_info "📋 Next steps:"
        echo "   1. If using iTerm2/Terminal: Set font to '$FONT_MESLO' (Regular, size 12-14)"
        echo "   2. Alacritty is configured (font, theme) and set as the default terminal"
        echo "   3. Restart your terminal or run: source ~/.zshrc"
        echo "   4. Run 'p10k configure' to customize your prompt (or use the default)"
        echo "   5. For non-Alacritty terminals: Apply colors from config/terminal-colors.md"
        echo "   6. Enjoy your improved terminal!"
        echo ""
    else
        print_warning "Setup completed with some issues. Please review the output above."
        exit 1
    fi
}

# Run main function
main "$@"
