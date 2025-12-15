#!/bin/bash

# Terminal Setup Script with Default Agnoster Theme
# Essential setup for modern terminal experience

set -e

# Constants
readonly DOTFILES_DIR="${DOTFILES_DIR:-$HOME/dotfiles}"
readonly ZSH_DIR="$HOME/.oh-my-zsh"
readonly ZSH_CUSTOM_DIR="$ZSH_DIR/custom"
readonly FONT_MESLO="Meslo LG Nerd Font"
readonly OH_MY_ZSH_URL="https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh"

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
    
    if [ -f "$dest" ] || [ -d "$dest" ] || [ -L "$dest" ]; then
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
    
    if [[ ! -d "$ZSH_DIR" ]]; then
        print_warning "Oh My Zsh not found. Installing..."
        if sh -c "$(curl -fsSL $OH_MY_ZSH_URL)" "" --unattended; then
            print_status "Oh My Zsh installed"
        else
            print_error "Failed to install Oh My Zsh"
            return 1
        fi
    else
        print_status "Oh My Zsh already installed"
    fi
    
    # Install zsh plugins if missing
    if [[ ! -d "$ZSH_CUSTOM_DIR/plugins/zsh-autosuggestions" ]]; then
        print_info "Installing zsh-autosuggestions..."
        git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH_CUSTOM_DIR/plugins/zsh-autosuggestions" 2>/dev/null || print_warning "Failed to install zsh-autosuggestions"
    fi
    
    if [[ ! -d "$ZSH_CUSTOM_DIR/plugins/zsh-syntax-highlighting" ]]; then
        print_info "Installing zsh-syntax-highlighting..."
        git clone https://github.com/zsh-users/zsh-syntax-highlighting.git "$ZSH_CUSTOM_DIR/plugins/zsh-syntax-highlighting" 2>/dev/null || print_warning "Failed to install zsh-syntax-highlighting"
    fi
    
    print_status "Dependencies checked"
}

# Install required fonts for Agnoster
install_fonts() {
    print_info "Installing fonts for Agnoster theme..."
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        if command -v brew &> /dev/null; then
            if brew install --cask font-meslo-lg-nerd-font 2>/dev/null; then
                print_status "$FONT_MESLO installed via Homebrew"
            else
                print_warning "Failed to install $FONT_MESLO via Homebrew"
            fi
        else
            print_warning "Homebrew not found. Please install $FONT_MESLO manually"
        fi
    else
        # Linux font installation
        FONT_DIR="$HOME/.local/share/fonts"
        mkdir -p "$FONT_DIR"
        print_info "For Linux, please install $FONT_MESLO manually or use your package manager"
    fi
    
    if command -v fc-cache &> /dev/null; then
        fc-cache -fv 2>/dev/null || true
    fi
}

# Configure zsh
configure_zsh() {
    print_info "Configuring Zsh..."
    
    local zshrc_file="$HOME/.zshrc"
    local dotfiles_zshrc="$DOTFILES_DIR/shell/.zshrc"
    
    # Create symlink for .zshrc
    if [[ -f "$dotfiles_zshrc" ]]; then
        backup_and_symlink "$dotfiles_zshrc" "$zshrc_file"
        print_status "Dotfiles .zshrc symlinked"
    fi
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
    
    if [[ ! -d "$ZSH_DIR" ]]; then
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
    echo "🎨 Setting up Terminal with Agnoster Theme"
    echo "=========================================="
    echo ""
    
    if ! check_dependencies; then
        print_error "Failed to install dependencies"
        exit 1
    fi
    
    install_fonts
    configure_zsh
    install_essential_tools
    
    echo ""
    if verify_installation; then
        print_status "✨ Terminal setup complete!"
        echo ""
        print_info "📋 Next steps:"
        echo "   1. Set your terminal font to '$FONT_MESLO'"
        echo "   2. Restart your terminal or run: source ~/.zshrc"
        echo "   3. Enjoy your improved terminal!"
        echo ""
    else
        print_warning "Setup completed with some issues. Please review the output above."
        exit 1
    fi
}

# Run main function
main "$@"
